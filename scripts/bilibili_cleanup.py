"""仅清除旧B站视频明细，保留其他平台及新的标签数量表。"""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

from lofter_cleanup import clean_snapshot as filter_snapshot, purge_database as purge_legacy
from tag_store import atomic_json


ROOT = Path(__file__).resolve().parents[1]


def purge_database(path):
    return purge_legacy(path, "bilibili")


def clean_snapshot(data):
    return filter_snapshot(data, "bilibili")


def other_platform_fingerprint(path):
    digest = hashlib.sha256()
    counts = {}
    with closing(sqlite3.connect(path, timeout=15)) as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        filters = {"works": "key NOT GLOB 'bilibili:*'",
                   "queries": "platform!='bilibili'", "work_operators": "platform!='bilibili'",
                   "coverage": "platform!='bilibili'", "metrics": "platform!='bilibili'"}
        for table in sorted(tables):
            if table.startswith("lofter_"):
                filters[table] = "1"
        for table, condition in sorted(filters.items()):
            if table not in tables:
                continue
            digest.update(table.encode())
            count = 0
            for row in db.execute(f"SELECT * FROM {table} WHERE {condition} ORDER BY 1"):
                digest.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
                count += 1
            counts[table] = count
    return {"sha256": digest.hexdigest(), "counts": counts}


def clean_project(root=ROOT):
    root = Path(root).resolve()
    report = {"databases": [], "snapshots": [], "removedFiles": []}
    databases = [root / ".local/http-collection.sqlite",
                 root / ".local/refactor-validation/http-collection.sqlite"]
    databases += sorted((root / ".local/backups").glob("*.sqlite"))
    for path in databases:
        if not path.exists():
            continue
        if not path.resolve().is_relative_to(root):
            raise ValueError("数据库路径超出项目，取消清理。")
        before = other_platform_fingerprint(path)
        removed = purge_database(path)
        after = other_platform_fingerprint(path)
        if before != after:
            raise RuntimeError("其他平台校验不一致，停止后续清理。")
        report["databases"].append({"path": path.relative_to(root).as_posix(),
                                    **removed, "otherPlatformsVerified": after})
    for name in [".local/http-live.json", ".local/observations.json", "public/data/live-heat.json", "public/data/live-heat.json.tmp"]:
        path = root / name
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            if path.name.endswith(".tmp"):
                path.unlink(); report["removedFiles"].append(name); continue
            raise
        cleaned, removed = clean_snapshot(data)
        if any(removed.values()):
            if isinstance(cleaned.get("metadata"), dict):
                # 旧快照中各查询状态的总数无法按平台反推，移除过时汇总。
                cleaned["metadata"].pop("tagQueries", None)
            atomic_json(path, cleaned)
        report["snapshots"].append({"path": name, "removed": removed})
    old_files = [root / ".local/bilibili-probe-result.json", root / ".local/bilibili-batch-probe-result.json",
                 root / ".local/bilibili-count-year-experiment.json", root / ".local/bilibili/amiya-probe.json"]
    old_files += list((root / ".local/bilibili").glob("run-*.log"))
    old_files += list((root / ".local/bilibili").glob("count-*.log"))
    for path in old_files:
        if path.exists() and path.resolve().is_relative_to(root):
            path.unlink(); report["removedFiles"].append(path.relative_to(root).as_posix())
    runtime = root / ".local/bilibili"
    atomic_json(runtime / "http-control.json", {"stop": True})
    atomic_json(runtime / "http-job.json", {
        "kind": "tag_count", "state": "pending", "totalTags": 434,
        "totalOperators": 434, "workers": 1, "interval": 3.5,
        "processedTags": 0, "completedTags": 0, "unavailableTags": 0,
        "requests": 0, "errors": [], "current": "",
        "message": "已切换标签累计数量；年度拆分未提供，等待启动。",
    })
    atomic_json(runtime / "cleanup-report.json", report)
    return report


def reset_counts(root=ROOT):
    """调用方持有B站运行锁；仅清理明确项目路径内的B站业务表。"""
    root = Path(root).resolve()
    report = clean_project(root)
    for entry in report["databases"]:
        path = root / entry["path"]
        before = other_platform_fingerprint(path)
        with closing(sqlite3.connect(path, timeout=15)) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                removed = {}
                for table in sorted(tables):
                    if not table.startswith("bilibili_") or not table.replace("_", "").isalnum():
                        continue
                    removed[table] = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                    db.execute(f'DELETE FROM "{table}"')
                db.commit()
                entry["removedBilibiliTables"] = removed
            except Exception:
                db.rollback()
                raise
        if before != other_platform_fingerprint(path):
            raise RuntimeError("其他平台校验不一致。")
    atomic_json(root / ".local/bilibili/http-job.json", {
        "kind": "search_result_count", "state": "pending", "totalTags": 434,
        "totalOperators": 434, "workers": 1, "interval": 3.5, "requests": 0,
        "processedTags": 0, "completedTags": 0, "unavailableTags": 0, "errors": [],
        "message": "旧B站统计已清除，等待按角色、明日方舟及联动作品组合搜索重新采集。",
    })
    from bilibili_search_export import export_counts
    export_counts(root)
    atomic_json(root / ".local/bilibili/cleanup-report.json", report)
    return report


if __name__ == "__main__":
    print(json.dumps(clean_project(), ensure_ascii=False))
