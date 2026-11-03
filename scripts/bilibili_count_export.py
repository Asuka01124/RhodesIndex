"""导出B站累计标签数量供网站读取，不生成年度或互动指标。"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlencode

from tag_session import ROOT, exact_count
from tag_store import atomic_json
from bilibili_tag_rules import rules_for, search_keyword


def count_snapshot(root=ROOT):
    root = Path(root)
    roster = json.loads((root / "public/data/operators.json").read_text(encoding="utf-8"))
    path = root / ".local/http-collection.sqlite"
    saved, queue = {}, {}
    if path.exists():
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
            db.execute("BEGIN")
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "bilibili_tag_stats" in tables:
                saved = {tag: json.loads(data) for tag, data in db.execute("SELECT tag_key,data FROM bilibili_tag_stats")}
            if "bilibili_tag_queue" in tables:
                for tag, state, note in db.execute("SELECT tag_key,state,note FROM bilibili_tag_queue ORDER BY rowid"):
                    queue[tag] = (state, note)
    records = []
    for operator in roster:
        tag = operator["name"]
        row = saved.get(tag, {})
        count = exact_count(row.get("workCount"))
        rules = rules_for(operator)
        valid = (row.get("tag") == tag and operator["id"] in row.get("operatorIds", [])
                 and row.get("countBasis") == "exact_tag_intersection"
                 and row.get("requiredTagGroups") == rules)
        if not valid:
            count = None
            row = {}
        state, note = queue.get(tag, ("pending", "尚未取得这个标签的统计。"))
        records.append({
            "operatorId": operator["id"], "tag": tag,
            "nativeTag": row.get("nativeTag", tag), "tagId": row.get("tagId"),
            "workCount": count, "status": "completed" if count is not None else state,
            "observedAt": row.get("observedAt"), "url": row.get("url"),
            "apiSourceUrl": row.get("apiSourceUrl") or "https://api.bilibili.com/x/web-interface/search/type?" + urlencode({"search_type": "video", "keyword": search_keyword(rules)}),
            "countBasis": "exact_tag_intersection", "requiredTagGroups": rules,
            "complete": row.get("complete", False), "searchExhausted": row.get("searchExhausted", False),
            "coverageNote": row.get("coverageNote", "尚未按多标签交集取得数据。"),
            "scannedRows": row.get("scannedRows", 0), "rejectedRows": row.get("rejectedRows", 0),
            "missingReason": None if count is not None else note,
            "updateError": note if count is not None and state in ("failed", "blocked") else None,
        })
    available = sum(row["workCount"] is not None for row in records)
    return {
        "schemaVersion": 1, "kind": "tag_count", "platform": "bilibili", "records": records,
        "metadata": {"plannedTags": len(roster), "availableTags": available,
                     "missingTags": len(roster) - available,
                     "coverage": "configured_tags" if available == len(roster) else "partial",
                     "generatedAt": max((r["observedAt"] for r in records if r["observedAt"]), default=None),
                     "timeBasis": "all_time_at_observation",
                     "countBasis": "exact_tag_intersection",
                     "methodology": "仅计入原生搜索标签同时包含角色、明日方舟及联动作品标签的去重视频；按时间窗口翻页核验。搜索可返回范围不等于全站总量；采集中、受限或截断如实标注。"},
    }


def export_counts(root=ROOT):
    root = Path(root)
    data = count_snapshot(root)
    atomic_json(root / ".local/bilibili/tag-counts.json", data)
    atomic_json(root / "public/data/bilibili-tag-counts.json", data)
    return data
