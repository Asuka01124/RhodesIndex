"""按平台条件清除旧 LOFTER 作品，不删除其他平台或加密会话。"""

import sqlite3


def purge_database(path):
    db = sqlite3.connect(path, timeout=15)
    try:
        db.execute("BEGIN IMMEDIATE")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        counts = {}
        before = db.execute("SELECT COUNT(*) FROM works WHERE key NOT GLOB 'lofter:*'").fetchone()[0] if "works" in tables else None
        if "queries" in tables:
            for table in ("seen", "faults"):
                if table in tables:
                    db.execute(f"DELETE FROM {table} WHERE query_key IN (SELECT key FROM queries WHERE platform='lofter')")
            db.execute("DELETE FROM queries WHERE platform='lofter'")
        for table in ("work_operators", "coverage", "metrics"):
            if table in tables:
                db.execute(f"DELETE FROM {table} WHERE platform='lofter'")
        if "work_operators" in tables:
            db.execute("DELETE FROM work_operators WHERE work_key GLOB 'lofter:*'")
        if "works" in tables:
            counts["removedWorks"] = db.execute("SELECT COUNT(*) FROM works WHERE key GLOB 'lofter:*'").fetchone()[0]
            db.execute("DELETE FROM works WHERE key GLOB 'lofter:*'")
            after = db.execute("SELECT COUNT(*) FROM works WHERE key NOT GLOB 'lofter:*'").fetchone()[0]
            if before != after:
                raise RuntimeError("其他平台作品数发生变化，已取消清理。")
            counts["preservedOtherWorks"] = after
        for table in ("lofter_pages", "lofter_queries", "lofter_watermarks"):
            if table in tables:
                counts[table] = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                db.execute(f"DELETE FROM {table}")
        db.commit()
        return counts
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def clean_snapshot(data):
    """只过滤旧 LOFTER 条目，不从快照恢复或回写业务数据库。"""
    result = dict(data)
    removed = {}
    for field in ("works", "records", "coverage"):
        if isinstance(data.get(field), list):
            result[field] = [row for row in data[field] if row.get("platform") != "lofter"]
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
