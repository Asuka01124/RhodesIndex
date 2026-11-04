"""逐件落库、分页断点与网站 JSON 汇总。"""

from __future__ import annotations
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid
from tag_session import LOCAL, ROOT


WEBSITE_EXCLUDED_PLATFORMS = {"pixiv"}


def website_snapshot(data):
    """生成网站视图，保留采集库中的原始记录。"""
    works = [row for row in data["works"] if row["platform"] not in WEBSITE_EXCLUDED_PLATFORMS]
    metadata = {
        **data["metadata"],
        "generatedAt": max((row["observedAt"] for row in works), default=None),
        "workCount": len(works),
        "operatorCount": len({operator for row in works for operator in row["operatorIds"]}),
        "platformCount": len({row["platform"] for row in works}),
    }
    metadata.pop("tagQueries", None)
    return {
        **data,
        "works": works,
        "records": [row for row in data["records"] if row["platform"] not in WEBSITE_EXCLUDED_PLATFORMS],
        "coverage": [row for row in data["coverage"] if row["platform"] not in WEBSITE_EXCLUDED_PLATFORMS],
        "metadata": metadata,
    }
from tag_sources import now


def atomic_json(filename: Path, value):
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_name(filename.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        for attempt in range(7):
            try:
                os.replace(temporary, filename)
                return
            except PermissionError:
                if attempt == 6:
                    raise
                time.sleep(0.05 * 2**attempt)
    finally:
        temporary.unlink(missing_ok=True)


class Store:
    def __init__(self, directory: Path = LOCAL):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(
            directory / "http-collection.sqlite", check_same_thread=False
        )
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS works(key TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS queries(key TEXT PRIMARY KEY,platform TEXT,operator TEXT,tag TEXT,kind TEXT,cursor TEXT,state TEXT,advertised INTEGER,pages INTEGER DEFAULT 0,note TEXT DEFAULT '');
          CREATE TABLE IF NOT EXISTS seen(query_key TEXT,item_id TEXT,PRIMARY KEY(query_key,item_id));
          CREATE TABLE IF NOT EXISTS faults(query_key TEXT,item_id TEXT,note TEXT,PRIMARY KEY(query_key,item_id));
          CREATE TABLE IF NOT EXISTS coverage(platform TEXT,operator TEXT,data TEXT,PRIMARY KEY(platform,operator));
          CREATE TABLE IF NOT EXISTS work_operators(platform TEXT,operator TEXT,work_key TEXT,PRIMARY KEY(platform,operator,work_key));
          CREATE TABLE IF NOT EXISTS metrics(platform TEXT,id TEXT,kind TEXT,PRIMARY KEY(platform,id));
        """)
        if not self.db.execute("SELECT 1 FROM works LIMIT 1").fetchone():
            old = directory / "observations.json"
            if old.exists():
                saved = json.loads(old.read_text(encoding="utf-8"))
                for work in saved.get("works", []):
                    self.put(work)
                for row in saved.get("coverage", []):
                    self.coverage(row)
        self.reindex()

    def reindex(self):
        """补齐干员归属索引；旧库里的作品是在建索引之前落库的。"""
        with self.lock:
            if self.db.execute("SELECT 1 FROM work_operators LIMIT 1").fetchone():
                return
            for row in self.db.execute("SELECT data FROM works"):
                work = json.loads(row[0])
                self.index(work)
            self.db.commit()

    def index(self, work):
        key = work["platform"] + ":" + work["id"]
        for operator in set(work.get("operatorIds") or []):
            self.db.execute(
                "INSERT OR IGNORE INTO work_operators VALUES(?,?,?)",
                (work["platform"], operator, key),
            )

    def matched(self, platform, operator_id):
        """该平台归属到这位干员的去重作品数；用索引查，不全表扫描。"""
        with self.lock:
            return self.db.execute(
                "SELECT COUNT(*) FROM work_operators WHERE platform=? AND operator=?",
                (platform, operator_id),
            ).fetchone()[0]

    def count_works(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM works").fetchone()[0]

    def get(self, platform, id):
        with self.lock:
            row = self.db.execute(
                "SELECT data FROM works WHERE key=?", (platform + ":" + id,)
            ).fetchone()
            return json.loads(row[0]) if row else None

    def put(self, work):
        with self.lock:
            old = self.get(work["platform"], work["id"])
            scopes = dict(old.get("matchScopes") or {}) if old else {}
            for oid, scope in (work.get("matchScopes") or {}).items():
                # 同一干员只要有一次是限定标签命中，就不再按裸名口径算。
                if scopes.get(oid) != "qualified":
                    scopes[oid] = scope
            work = {
                **work,
                "operatorIds": sorted(
                    set(work.get("operatorIds") or [])
                    | set(old.get("operatorIds", []) if old else [])
                ),
                "matchedTags": sorted(
                    set(work.get("matchedTags") or [])
                    | set(old.get("matchedTags", []) if old else [])
                ),
                "matchScopes": scopes,
            }
            if not work.get("matchReason") and old:
                work["matchReason"] = old.get("matchReason", "")
            if old:
                self.carry_metrics(work, old)
            self.db.execute(
                "INSERT OR REPLACE INTO works VALUES(?,?)",
                (
                    work["platform"] + ":" + work["id"],
                    json.dumps(work, ensure_ascii=False),
                ),
            )
            self.index(work)
            if work.get("likes") is not None:
                self.dequeue_metric(work["platform"], work["id"])
            self.db.commit()

    @staticmethod
    def carry_metrics(work, old):
        """翻页阶段重放不能把已经取到的点赞与播放冲掉。

        真实的 0 要留着，只有 None 才是缺失；缺失的旧值不必抢救，
        但已经观察到的数值一旦被 None 覆盖就等于凭空丢数据。
        """
        absent = dict(work.get("missing") or {})
        for metric in ("likes", "views"):
            if work.get(metric) is None and old.get(metric) is not None:
                work[metric] = old[metric]
                absent.pop(metric, None)
        work["missing"] = absent
        native = dict(old.get("nativeMetrics") or {})
        native.update(
            {k: v for k, v in (work.get("nativeMetrics") or {}).items() if v is not None}
        )
        work["nativeMetrics"] = native

    def queue_metric(self, platform, id, kind):
        """点赞只能事后逐件补的作品进队列；补到了由 put 负责出队。"""
        with self.lock:
            self.db.execute(
                "INSERT OR IGNORE INTO metrics VALUES(?,?,?)", (platform, id, kind)
            )
            self.db.commit()

    def dequeue_metric(self, platform, id):
        with self.lock:
            self.db.execute(
                "DELETE FROM metrics WHERE platform=? AND id=?", (platform, id)
            )

    def pending_metrics(self, platform, limit=0):
        with self.lock:
            rows = self.db.execute(
                "SELECT id,kind FROM metrics WHERE platform=?"
                + (" LIMIT %d" % int(limit) if limit else ""),
                (platform,),
            ).fetchall()
            return [dict(id=row[0], kind=row[1]) for row in rows]

    def metrics_remaining(self, platform):
        with self.lock:
            return self.db.execute(
                "SELECT COUNT(*) FROM metrics WHERE platform=?", (platform,)
            ).fetchone()[0]

    def query(self, key, platform, operator, tag, kind, resume):
        with self.lock:
            row = self.db.execute(
                "SELECT cursor,state,advertised,pages FROM queries WHERE key=?", (key,)
            ).fetchone()
            if row and resume:
                if row[1] == "exhausted":
                    return {"done": True, "cursor": None, "pages": row[3]}
                if row[1] not in ("partial", "failed"):
                    return {
                        "done": False,
                        "cursor": json.loads(row[0]),
                        "pages": row[3],
                    }
            self.db.execute(
                "INSERT OR REPLACE INTO queries VALUES(?,?,?,?,?,?,?,NULL,0,?)",
                (key, platform, operator, tag, kind, "null", "running", ""),
            )
            self.db.execute("DELETE FROM seen WHERE query_key=?", (key,))
            self.db.execute("DELETE FROM faults WHERE query_key=?", (key,))
            self.db.commit()
            return {"done": False, "cursor": None, "pages": 0}

    def seen(self, key, id):
        with self.lock:
            previous = self.db.total_changes
            self.db.execute("INSERT OR IGNORE INTO seen VALUES(?,?)", (key, id))
            added = self.db.total_changes > previous
            self.db.commit()
            return added

    def fault(self, key, id, note):
        with self.lock:
            self.db.execute(
                "INSERT OR REPLACE INTO faults VALUES(?,?,?)", (key, id, note)
            )
            self.db.commit()

    def checkpoint(self, key, cursor, state, pages, advertised=None, note=""):
        with self.lock:
            self.db.execute(
                "UPDATE queries SET cursor=?,state=?,pages=?,advertised=?,note=? WHERE key=?",
                (json.dumps(cursor), state, pages, advertised, note, key),
            )
            self.db.commit()

    def query_counts(self, key):
        with self.lock:
            return (
                self.db.execute(
                    "SELECT COUNT(*) FROM seen WHERE query_key=?", (key,)
                ).fetchone()[0],
                self.db.execute(
                    "SELECT COUNT(*) FROM faults WHERE query_key=?", (key,)
                ).fetchone()[0],
            )

    def coverage(self, row):
        with self.lock:
            self.db.execute(
                "INSERT OR REPLACE INTO coverage VALUES(?,?,?)",
                (
                    row["platform"],
                    row["operatorId"],
                    json.dumps(row, ensure_ascii=False),
                ),
            )
            self.db.commit()

    def snapshot(self):
        with self.lock:
            works = [
                json.loads(row[0]) for row in self.db.execute("SELECT data FROM works")
            ]
            coverage = [
                json.loads(row[0])
                for row in self.db.execute("SELECT data FROM coverage")
            ]
            counts = dict(
                self.db.execute(
                    "SELECT state,COUNT(*) FROM queries GROUP BY state"
                ).fetchall()
            )
        records = {}
        for work in works:
            year = (
                datetime.fromisoformat(work["publishedAt"].replace("Z", "+00:00"))
                .astimezone(timezone(timedelta(hours=8)))
                .year
            )
            for operator in set(work["operatorIds"]):
                key = (operator, work["platform"], year)
                row = records.setdefault(
                    key,
                    dict(
                        operatorId=operator,
                        platform=work["platform"],
                        year=year,
                        likes=None,
                        views=None,
                        sourceUrls=[],
                        observedAt=work["observedAt"],
                        workCount=0,
                        types={},
                        scopes={"qualified": 0, "bare": 0, "unknown": 0},
                        metricCoverage={"likes": 0, "views": 0},
                        metricMissing={"likes": 0, "views": 0},
                    ),
                )
                row["workCount"] += 1
                row["sourceUrls"].append(work["url"])
                row["observedAt"] = max(row["observedAt"], work["observedAt"])
                kind = work.get("type") or "未记录"
                row["types"][kind] = row["types"].get(kind, 0) + 1
                scope = (work.get("matchScopes") or {}).get(operator) or "unknown"
                row["scopes"][scope] = row["scopes"].get(scope, 0) + 1
                for metric in ["likes", "views"]:
                    if work.get(metric) is not None:
                        row[metric] = (row[metric] or 0) + work[metric]
                        row["metricCoverage"][metric] += 1
                    else:
                        row["metricMissing"][metric] += 1
        return dict(
            schemaVersion=1,
            yearBasis="publication_year",
            records=list(records.values()),
            works=works,
            coverage=coverage,
            metadata=dict(
                kind="collected",
                generatedAt=max((w["observedAt"] for w in works), default=None),
                coverage="partial",
                workCount=len(works),
                operatorCount=len({id for w in works for id in w["operatorIds"]}),
                platformCount=len({w["platform"] for w in works}),
                requestMode="http_session",
                unbounded=True,
                tagQueries=counts,
                methodology="纯 HTTP Session 按配置的角色标签翻页到接口结束，无作品数量采样上限。已取完仅表示该标签接口已返回结束，不保证平台未返回的作品、私密作品或接口截断数据已覆盖。按作品发布时间（北京时间）归年；互动为观察时累计值，不是当年新增。",
            ),
        )

    def export(self):
        data = self.snapshot()
        # 原始 SQLite 是断点与作品的主存储；JSON 供网站直接读取。
        live = website_snapshot(data) if self.directory == LOCAL else data
        atomic_json(self.directory / "http-live.json", live)
        if self.directory == LOCAL:
            try:
                atomic_json(ROOT / "public/data/live-heat.json", live)
            except PermissionError:
                pass  # 网站本地接口读取 http-live.json，仍能呈现最新数据。
        return data
