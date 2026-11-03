"""按指定平台清除旧作品，不删除其他平台或加密会话。"""

from pathlib import Path
import hashlib
import json
import sqlite3

from tag_store import atomic_json


def purge_database(path, platform="lofter", clear_tag_stats=False):
    if platform not in ("lofter", "bilibili"):
        raise ValueError("清理平台无效。")
    if clear_tag_stats and platform != "lofter":
        raise ValueError("本次完整重置只适用于LOFTER。")
    db = sqlite3.connect(path, timeout=15)
    try:
        db.execute("BEGIN IMMEDIATE")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {}
        # 同一写事务内核验B站数量表，避免把后台正常新增误判成清理造成的变化。
        preserved_tables = [t for t in ("bilibili_tag_stats", "bilibili_tag_history", "bilibili_tag_queue") if t in tables]
        def preserved_hash():
            digest = hashlib.sha256()
            sizes = {}
            for table in preserved_tables:
                rows = db.execute(f"SELECT * FROM {table} ORDER BY 1,2").fetchall()
                digest.update(table.encode())
                digest.update(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode())
                sizes[table] = len(rows)
            return digest.hexdigest(), sizes
        preserved_before = preserved_hash() if platform == "lofter" else None
        before = db.execute(f"SELECT COUNT(*) FROM works WHERE key NOT GLOB '{platform}:*'").fetchone()[0] if "works" in tables else None
        if "queries" in tables:
            for table in ("seen", "faults"):
                if table in tables:
                    db.execute(f"DELETE FROM {table} WHERE query_key IN (SELECT key FROM queries WHERE platform='{platform}')")
            db.execute(f"DELETE FROM queries WHERE platform='{platform}'")
        for table in ("work_operators", "coverage", "metrics"):
            if table in tables:
                db.execute(f"DELETE FROM {table} WHERE platform='{platform}'")
        if "work_operators" in tables:
            db.execute(f"DELETE FROM work_operators WHERE work_key GLOB '{platform}:*'")
        if "works" in tables:
            counts["removedWorks"] = db.execute(f"SELECT COUNT(*) FROM works WHERE key GLOB '{platform}:*'").fetchone()[0]
            db.execute(f"DELETE FROM works WHERE key GLOB '{platform}:*'")
            after = db.execute(f"SELECT COUNT(*) FROM works WHERE key NOT GLOB '{platform}:*'").fetchone()[0]
            if before != after:
                raise RuntimeError("其他平台作品数发生变化，已取消清理。")
            counts["preservedOtherWorks"] = after
        legacy_tables = ("lofter_pages", "lofter_queries", "lofter_watermarks") if platform == "lofter" else ()
        if clear_tag_stats:
            legacy_tables += ("lofter_tag_stats", "lofter_tag_history", "lofter_tag_queue")
        for table in legacy_tables:
            if table in tables:
                counts[table] = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                db.execute(f"DELETE FROM {table}")
        if preserved_before is not None:
            if preserved_before != preserved_hash():
                raise RuntimeError("B站数量记录发生非预期变化，已取消清理。")
            counts["preservedBilibiliTagTables"] = preserved_before[1]
            counts["preservedBilibiliTagHash"] = preserved_before[0]
        db.commit()
        return counts
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def clean_snapshot(data, platform="lofter"):
    """只过滤指定平台条目，不从快照恢复或回写业务数据库。"""
    result = dict(data)
    removed = {}
    for field in ("works", "records", "coverage"):
        if isinstance(data.get(field), list):
            result[field] = [row for row in data[field] if row.get("platform") != platform]
            removed[field] = len(data[field]) - len(result[field])
    if any(removed.values()) and isinstance(result.get("metadata"), dict):
        meta = dict(result["metadata"])
        if "works" in result:
            works = result["works"]
            meta.update(workCount=len(works),
                        operatorCount=len({oid for w in works for oid in w.get("operatorIds", [])}),
                        platformCount=len({w["platform"] for w in works}))
        result["metadata"] = meta
    return result, removed


def reset_project(root):
    """清除项目内旧LOFTER明细与标签快照，保留其他平台及登录会话。"""
    root = Path(root).resolve()
    report = {"databases": [], "snapshots": [], "removedFiles": []}
    paths = [root / ".local/http-collection.sqlite", root / ".local/refactor-validation/http-collection.sqlite"]
    paths += sorted((root / ".local/backups").glob("*.sqlite"))
    for path in paths:
        if path.exists():
            if not path.resolve().is_relative_to(root):
                raise ValueError("数据库路径超出项目，取消清理。")
            result = purge_database(path, clear_tag_stats=True)
            report["databases"].append({"path": path.relative_to(root).as_posix(), **result})
    for name in (".local/http-live.json", ".local/observations.json", "public/data/live-heat.json", "public/data/live-heat.json.tmp"):
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
                cleaned["metadata"].pop("tagQueries", None)
            atomic_json(path, cleaned)
        report["snapshots"].append({"path": name, "removed": removed})
    runtime = root / ".local/lofter"
    for path in runtime.glob("*.log"):
        if not path.resolve().is_relative_to(root):
            raise ValueError("日志路径超出项目，取消清理。")
        path.unlink(); report["removedFiles"].append(path.relative_to(root).as_posix())
    atomic_json(runtime / "http-control.json", {"stop": True})
    atomic_json(runtime / "http-job.json", {
        "kind": "tag_summary", "state": "pending", "scope": "primary",
        "totalOperators": 434, "totalTags": 434, "workers": 3, "interval": 3.5,
        "processedTags": 0, "completedTags": 0, "unavailableTags": 0,
        "requests": 0, "errors": [], "current": "",
        "message": "旧LOFTER数据已清理，等待434个中文主标签的新一轮采集。",
    })
    atomic_json(runtime / "cleanup-report.json", report)
    return report
