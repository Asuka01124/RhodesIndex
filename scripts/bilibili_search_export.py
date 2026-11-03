"""只导出组合搜索结果数；旧单标签和严格交集记录不混入网站。"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlencode

from bilibili_tag_rules import rules_for, search_keyword
from tag_session import ROOT, exact_count
from tag_store import atomic_json


def count_snapshot(root=ROOT):
    root = Path(root)
    roster = json.loads((root / "public/data/operators.json").read_text(encoding="utf-8"))
    saved, queue = {}, {}
    try:
        job = json.loads((root / ".local/bilibili/http-job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        job = {}
    path = root / ".local/http-collection.sqlite"
    if path.exists():
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
            db.execute("BEGIN")
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "bilibili_tag_stats" in tables:
                saved = {tag: json.loads(data) for tag, data in db.execute("SELECT tag_key,data FROM bilibili_tag_stats")}
            if "bilibili_tag_queue" in tables and job.get("kind") == "search_result_count":
                queue = {tag: (state, note) for tag, state, note in db.execute(
                    "SELECT tag_key,state,note FROM bilibili_tag_queue WHERE run_id=?", (job.get("id"),))}
    records = []
    for operator in roster:
        tag = operator["name"]
        terms = [group[0] for group in rules_for(operator)]
        query = search_keyword(rules_for(operator))
        row = saved.get(tag, {})
        valid = (row.get("countBasis") == "search_result_total" and row.get("tag") == tag
                 and operator["id"] in row.get("operatorIds", [])
                 and row.get("query") == query and row.get("searchTerms") == terms)
        if not valid:
            row = {}
        count = exact_count(row.get("workCount"))
        state, note = queue.get(tag, ("pending", "尚未按组合搜索取得统计。"))
        records.append({
            "operatorId": operator["id"], "tag": tag, "nativeTag": tag, "tagId": None,
            "workCount": count, "status": "completed" if count is not None else state,
            "query": query, "searchTerms": terms, "countBasis": "search_result_total",
            "observedAt": row.get("observedAt"), "url": row.get("url"),
            "apiSourceUrl": row.get("apiSourceUrl") or "https://api.bilibili.com/x/web-interface/search/type?" + urlencode({"search_type": "video", "keyword": query}),
            "complete": row.get("complete", False), "lowerBound": count is not None and not row.get("complete", False),
            "searchExhausted": row.get("searchExhausted", False),
            "coverageNote": row.get("coverageNote", "尚未取得组合搜索结果数。"),
            "countedWindows": row.get("countedWindows", 0), "pendingWindows": row.get("pendingWindows", 0),
            "missingReason": None if count is not None else note,
            "updateError": note if count is not None and state in ("failed", "blocked") else None,
        })
    available = sum(row["workCount"] is not None for row in records)
    return {
        "schemaVersion": 1, "kind": "tag_count", "platform": "bilibili", "records": records,
        "metadata": {
            "plannedTags": len(roster), "availableTags": available, "missingTags": len(roster) - available,
            "coverage": "configured_tags" if all(row["workCount"] is not None and row["complete"] for row in records) else "partial",
            "generatedAt": max((row["observedAt"] for row in records if row["observedAt"]), default=None),
            "timeBasis": "all_time_at_observation", "countBasis": "search_result_total",
            "methodology": "组合搜索：角色名＋明日方舟，联动再加作品名。读取原生搜索总数，1000触顶时分时间段汇总，不逐条核验标签。仅代表搜索索引返回范围。",
        },
    }


def export_counts(root=ROOT):
    root = Path(root)
    data = count_snapshot(root)
    atomic_json(root / ".local/bilibili/tag-counts.json", data)
    atomic_json(root / "public/data/bilibili-tag-counts.json", data)
    return data
