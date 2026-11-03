"""LOFTER网站快照：保留平台浏览／参与原文、精度、来源和空值。"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3

from tag_session import ROOT
from tag_store import atomic_json


def count_snapshot(root=ROOT):
    root = Path(root)
    roster = json.loads((root / "public/data/operators.json").read_text(encoding="utf-8"))
    saved, queue = {}, {}
    path = root / ".local/http-collection.sqlite"
    if path.exists():
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
            db.execute("BEGIN")
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "lofter_tag_stats" in tables:
                saved = {tag: json.loads(data) for tag, data in db.execute("SELECT tag_key,data FROM lofter_tag_stats")}
            if "lofter_tag_queue" in tables:
                for tag, state, note in db.execute("SELECT tag_key,state,note FROM lofter_tag_queue ORDER BY rowid"):
                    queue[tag] = (state, note)
    records = []
    for operator in roster:
        tag = operator["name"]
        row = saved.get(tag, {})
        if row.get("tag") != tag or operator["id"] not in row.get("operatorIds", []):
            row = {}
        state, note = queue.get(tag, ("pending", "尚未取得这个标签的统计。"))
        usable = row.get("status") == "ok"
        records.append({
            "operatorId": operator["id"], "tag": tag, "url": row.get("url"),
            "views": row.get("views") if usable else None,
            "participation": row.get("participation") if usable else None,
            "status": row.get("status", state), "observedAt": row.get("observedAt"),
            "missingReason": None if usable else row.get("missingReason") or note,
            "updateError": note if usable and state in ("failed", "blocked") else None,
        })
    available = sum(r["views"] is not None and r["participation"] is not None for r in records)
    return {"schemaVersion": 1, "kind": "tag_summary", "platform": "lofter", "records": records,
            "metadata": {"plannedTags": len(roster), "availableTags": available,
                         "missingTags": len(roster) - available, "coverage": "partial",
                         "generatedAt": max((r["observedAt"] for r in records if r["observedAt"]), default=None),
                         "timeBasis": "all_time_at_observation",
                         "methodology": "平台中文标签页的累计浏览及参与显示值；万、亿或加号保留原文并标为约数，不冒充精确整数或已去重作品总数。不同标签有重叠，不相加。"}}


def export_counts(root=ROOT):
    root = Path(root)
    data = count_snapshot(root)
    atomic_json(root / ".local/lofter/tag-counts.json", data)
    atomic_json(root / "public/data/lofter-tag-counts.json", data)
    return data


if __name__ == "__main__":
    print(json.dumps(export_counts()["metadata"], ensure_ascii=False))
