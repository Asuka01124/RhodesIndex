"""LOFTER 标签快照的存储、断点与调度；与逐作品统计分开保存。"""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import queue
import signal
import sqlite3
import threading
import time
import uuid

from collector_sources.base import now
from collector_sources.lofter_tags import LofterTags
from tag_match import Matcher, qualified
from tag_session import CollectError, LOCAL
from tag_store import atomic_json


RUNTIME = LOCAL / "lofter"


def make_plan(operators, roster=None, primary_only=True):
    matcher = Matcher(roster if roster is not None else operators)
    plan = {}
    for operator in operators:
        tags = [operator["name"]] if primary_only else matcher.aliases(operator, "lofter")
        for tag in tags:
            # 平台的大小写／全半角标签是否等价尚未核验，不擅自合并。
            key = tag
            owners = matcher.owners(tag)
            item = plan.setdefault(key, {"key": key, "tag": tag, "operatorIds": [],
                                        "scope": "qualified" if qualified(tag) else "bare"})
            item["operatorIds"] = sorted(set(item["operatorIds"]) | owners)
    return list(plan.values())


class TagStatsStore:
    def __init__(self, directory=LOCAL, platform="lofter"):
        if platform not in ("lofter", "bilibili", "douyin"):
            raise ValueError("标签统计平台无效。")
        self.platform = platform
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory / "http-collection.sqlite", check_same_thread=False, timeout=10)
        self.db.executescript(f"""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS {self.platform}_tag_stats(tag_key TEXT PRIMARY KEY,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS {self.platform}_tag_history(run_id TEXT,tag_key TEXT,data TEXT NOT NULL,
                PRIMARY KEY(run_id,tag_key));
            CREATE TABLE IF NOT EXISTS {self.platform}_tag_queue(run_id TEXT,tag_key TEXT,state TEXT,note TEXT,
                PRIMARY KEY(run_id,tag_key));
        """)

    def done(self, run_id):
        with self.lock:
            return {r[0] for r in self.db.execute(
                f"SELECT tag_key FROM {self.platform}_tag_queue WHERE run_id=? AND state IN ('completed','unavailable')", (run_id,)
            )}

    def put(self, run_id, item, observation):
        record = {**observation, "operatorIds": item["operatorIds"], "scope": item["scope"]}
        encoded = json.dumps(record, ensure_ascii=False)
        with self.lock:
            try:
                self.db.execute(f"INSERT OR REPLACE INTO {self.platform}_tag_stats VALUES(?,?)", (item["key"], encoded))
                self.db.execute(f"INSERT OR REPLACE INTO {self.platform}_tag_history VALUES(?,?,?)", (run_id, item["key"], encoded))
                self.db.execute(f"INSERT OR REPLACE INTO {self.platform}_tag_queue VALUES(?,?,?,?)", (
                    run_id, item["key"], self.completed_state(record),
                    record.get("missingReason", ""),
                ))
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
        return record

    def completed_state(self, record):
        return "unavailable" if record.get("status") == "unavailable" else "completed"

    def fail(self, run_id, key, state, note):
        with self.lock:
            self.db.execute(f"INSERT OR REPLACE INTO {self.platform}_tag_queue VALUES(?,?,?,?)", (run_id, key, state, note))
            self.db.commit()

    def coverage(self, run_id, plan):
        done = self.done(run_id)
        with self.lock:
            successful = {r[0] for r in self.db.execute(
                f"SELECT tag_key FROM {self.platform}_tag_queue WHERE run_id=? AND state='completed'", (run_id,)
            )}
        groups = {}
        for item in plan:
            for oid in item["operatorIds"]:
                group = groups.setdefault(oid, [])
                group.append(item["key"] in successful)
        return {"operatorsWithData": sum(any(v) for v in groups.values()),
                "completedOperators": sum(all(v) for v in groups.values()),
                "completedTags": len(successful), "processedTags": len(done),
                "unavailableTags": len(done - successful)}


class TagStatsCollector:
    kind = "tag_summary"
    label = "LOFTER"

    def __init__(self, operators, roster=None, workers=3, interval=3.5, resume=True,
                 primary_only=True, store=None, source=None, runtime=RUNTIME, plan=None):
        self.operators = operators
        self.plan = make_plan(operators, roster, primary_only) if plan is None else plan
        self.store = store if store is not None else TagStatsStore()
        self.source = source if source is not None else LofterTags(interval)
        self.runtime = Path(runtime)
        self.workers = workers
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.halted = threading.Event()
        self.source.cancelled = self.stopping
        digest = hashlib.sha256(json.dumps(self.plan, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        try:
            old = json.loads((self.runtime / "http-job.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = {}
        continuation = (resume and old.get("kind") == self.kind
                        and old.get("planHash") == digest and old.get("state") in ("running", "cancelled", "failed"))
        run_id = old["id"] if continuation else str(uuid.uuid4())
        self.job = {"id": run_id, "kind": self.kind, "state": "running", "planHash": digest,
                    "scope": "primary" if primary_only else "all_aliases", "workers": workers, "interval": interval,
                    "startedAt": old["startedAt"] if continuation else now(), "finishedAt": None,
                    "totalOperators": len(operators), "totalTags": len(self.plan), "current": "",
                    "requests": 0, "errors": [], "lastObservation": None}
        self.job.update(self.store.coverage(run_id, self.plan))
        self.queue = queue.Queue()
        done = self.store.done(run_id)
        for item in self.plan:
            if item["key"] not in done:
                self.queue.put(item)

    def stopping(self):
        if self.stop_event.is_set():
            return True
        try:
            if json.loads((self.runtime / "http-control.json").read_text(encoding="utf-8")).get("stop"):
                self.stop_event.set()
        except (OSError, ValueError):
            pass
        return self.stop_event.is_set()

    def worker(self):
        while not self.stopping() and not self.halted.is_set():
            try:
                item = self.queue.get_nowait()
            except queue.Empty:
                return
            with self.lock:
                self.job["current"] = "#" + item["tag"]
            try:
                observation = self.source.read(item["tag"])
                record = self.store.put(self.job["id"], item, observation)
                with self.lock:
                    self.job["lastObservation"] = record
            except CollectError as error:
                state = error.kind if error.kind in ("blocked", "cancelled") else "failed"
                self.store.fail(self.job["id"], item["key"], state, str(error))
                with self.lock:
                    self.job["errors"].append(f"#{item['tag']}：{error}")
                    self.job["errors"] = self.job["errors"][-100:]
                if state == "blocked":
                    self.halted.set()
            except Exception as error:
                note = f"标签读取失败（{type(error).__name__}），可从断点重试。"
                self.store.fail(self.job["id"], item["key"], "failed", note)
                with self.lock:
                    self.job["errors"].append(f"#{item['tag']}：{note}")

    def publish(self):
        with self.lock:
            self.job.update(self.store.coverage(self.job["id"], self.plan))
            self.job["requests"] = self.source.requests
            atomic_json(self.runtime / "http-job.json", self.job)
        if self.store.platform == "lofter" and self.store.directory == LOCAL and self.runtime == RUNTIME:
            signature = (self.job["state"], self.job["requests"], self.job["processedTags"])
            if signature != getattr(self, "_exported_signature", None):
                from lofter_tag_export import export_counts
                export_counts()
                self._exported_signature = signature

    def run(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        atomic_json(self.runtime / "http-control.json", {"stop": False})
        signal.signal(signal.SIGINT, lambda *_: self.stop_event.set())
        self.publish()
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = [executor.submit(self.worker) for _ in range(self.workers)]
            while not all(f.done() for f in futures):
                self.publish()
                time.sleep(2)
        self.publish()
        self.job["state"] = "cancelled" if self.stopping() else (
            ("partial" if self.job["unavailableTags"] else "completed")
            if len(self.store.done(self.job["id"])) == len(self.plan) else "failed"
        )
        self.job["finishedAt"] = now()
        self.publish()
        print(f"{self.label} 已处理 {self.job['processedTags']}/{self.job['totalTags']} 个标签；"
              f"可读统计 {self.job['completedTags']} 个，缺失 {self.job['unavailableTags']} 个。", flush=True)
        return self.job["state"]
