"""导出抖音话题累计播放量；只整理本地统计，不请求平台或导出凭据。"""

from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlencode

from collector_sources.douyin_topics import ENDPOINT
from douyin_topic_runtime import make_topic_plan
from tag_session import ROOT, exact_count
from tag_store import atomic_json


def count_snapshot(root=ROOT):
    root = Path(root)
    roster = json.loads((root / "public/data/operators.json").read_text(encoding="utf-8"))
    plan = make_topic_plan(roster)
    by_id = {operator["id"]: operator for operator in roster}
    try:
        raw = json.loads((root / ".local/douyin/topic-counts.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    saved = {row["tag"]: row for row in raw.get("records", []) if isinstance(row, dict) and isinstance(row.get("tag"), str)}
    queue = {}
    db_path = root / ".local/http-collection.sqlite"
    if db_path.exists():
        with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "douyin_tag_queue" in tables:
                queue = {tag: (state, note) for tag, state, note in db.execute(
                    "SELECT tag_key,state,note FROM douyin_tag_queue WHERE run_id=?", (raw.get("metadata", {}).get("runId"),))}
    records = []
    for item in plan:
        tag = item["tag"]
        owners = item["operatorIds"]
        representative = next((oid for oid in owners if by_id[oid]["name"] == tag), owners[0])
        source = ENDPOINT + "?" + urlencode({"keyword": tag, "source": "challenge_create", "aid": "2906"})
        row = saved.get(tag, {})
        value = exact_count(row.get("playCount"))
        native = exact_count((row.get("native") or {}).get("view_count"))
        try:
            datetime.fromisoformat(row.get("observedAt", "").replace("Z", "+00:00"))
            has_time = True
        except (TypeError, ValueError, AttributeError):
            has_time = False
        valid = (row.get("status") == "ok" and value is not None and native == value and has_time
                 and row.get("sourceUrl") == source and set(owners) <= set(row.get("operatorIds", []))
                 and isinstance(row.get("topicId"), str) and re.fullmatch(r"[1-9][0-9]*", row["topicId"]))
        state, note = queue.get(tag, ("pending", "尚未取得这个话题的统计。"))
        records.append({
            "operatorId": representative, "operatorIds": owners, "tag": tag,
            "topicId": row["topicId"] if valid else None,
            "playCount": value if valid else None, "nativeViewCount": native if valid else None,
            "status": "completed" if valid else "failed" if state == "completed" else state,
            "observedAt": row["observedAt"] if valid else None,
            "url": source, "apiSourceUrl": source,
            "missingReason": None if valid else row.get("missingReason") or ("已保存结果缺少有效的话题来源或原生计数。" if row else note) or "尚未取得统计。",
            "association": "exact_topic_name_only_operator_identity_unverified",
        })
    available = sum(row["playCount"] is not None for row in records)
    return {
        "schemaVersion": 1, "kind": "topic_summary", "platform": "douyin", "records": records,
        "metadata": {
            "plannedTags": len(plan), "plannedOperators": len(roster), "availableTags": available,
            "missingTags": len(plan) - available, "coverage": "configured_tags" if available == len(plan) else "partial",
            "generatedAt": max((row["observedAt"] for row in records if row["observedAt"]), default=None),
            "timeBasis": "all_time_at_observation", "metric": "native_view_count",
            "methodology": "平台同名话题的原生累计播放量，不是作品数或独立热度指数；同名内容归属待核实。阿米娅三个职业形态共用一份统计，不重复相加。",
        },
    }


def export_counts(root=ROOT):
    root = Path(root)
    data = count_snapshot(root)
    atomic_json(root / ".local/douyin/tag-counts.json", data)
    atomic_json(root / "public/data/douyin-tag-counts.json", data)
    return data
