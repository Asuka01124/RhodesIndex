"""旧 LOFTER 逐作品调度，已停用；当前入口改用 lofter_tag_stats.py。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import queue
import signal
import threading
import time
import uuid

from collector_sources.base import now
from collector_sources.lofter import Lofter
from tag_match import Matcher, qualified
from tag_session import CollectError, LOCAL
from tag_store import Store, atomic_json


RUNTIME = LOCAL / "lofter"


class LofterStore(Store):
    def __init__(self, directory=LOCAL):
        super().__init__(directory)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS lofter_queries(
                tag TEXT, mode TEXT, data TEXT NOT NULL, PRIMARY KEY(tag,mode));
            CREATE TABLE IF NOT EXISTS lofter_watermarks(
                tag TEXT PRIMARY KEY, checked_until INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS lofter_pages(
                cycle TEXT, fingerprint TEXT, PRIMARY KEY(cycle,fingerprint));
        """)

    def checkpoint(self, tag, mode):
        with self.lock:
            row = self.db.execute(
                "SELECT data FROM lofter_queries WHERE tag=? AND mode=?", (tag, mode)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def watermark(self, tag):
        with self.lock:
            row = self.db.execute(
                "SELECT checked_until FROM lofter_watermarks WHERE tag=?", (tag,)
            ).fetchone()
        return row[0] if row else 0

    def save(self, state, fingerprint=None, complete=False):
        with self.lock:
            try:
                if fingerprint:
                    self.db.execute(
                        "INSERT INTO lofter_pages VALUES(?,?)", (state["cycle"], fingerprint)
                    )
                self.db.execute(
                    "INSERT OR REPLACE INTO lofter_queries VALUES(?,?,?)",
                    (state["tag"], state["mode"], json.dumps(state, ensure_ascii=False)),
                )
                if complete:
                    self.db.execute(
                        "INSERT INTO lofter_watermarks VALUES(?,?) "
                        "ON CONFLICT(tag) DO UPDATE SET checked_until=MAX(checked_until,excluded.checked_until)",
                        (state["tag"], state["upper_ms"]),
                    )
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise

    def has_page(self, cycle, fingerprint):
        with self.lock:
            return self.db.execute(
                "SELECT 1 FROM lofter_pages WHERE cycle=? AND fingerprint=?",
                (cycle, fingerprint),
            ).fetchone() is not None

    def work_count(self):
        with self.lock:
            return self.db.execute(
                "SELECT COUNT(*) FROM works WHERE key GLOB 'lofter:*'"
            ).fetchone()[0]


class LofterCollector:
    def __init__(
        self, operators, mode="full", resume=True, interval=3.5, workers=3,
        overlap_hours=48, store=None, runtime=RUNTIME, source=None, matcher=None,
    ):
        self.operators = operators
        self.matcher = matcher if matcher is not None else Matcher(operators)
        self.mode = mode
        self.resume = resume
        self.overlap_ms = int(overlap_hours * 3600000)
        self.store = store if store is not None else LofterStore()
        self.runtime = Path(runtime)
        self.source = source if source is not None else Lofter(interval)
        self.source.cancelled = self.stopping
        self.workers = workers
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.queue = queue.Queue()
        self.active = 0
        self.halted = threading.Event()
        self.job = {
            "id": str(uuid.uuid4()), "state": "running", "mode": mode,
            "startedAt": now(), "finishedAt": None, "current": "",
            "totalOperators": len(operators), "totalTags": 0,
            "finishedTags": 0, "errors": [], "requests": 0,
        }
        tags = list(dict.fromkeys(
            tag for op in operators for tag in self.matcher.aliases(op, "lofter")
        ))
        for tag in tags:
            self.queue.put(self.unit(tag))
        self.job["totalTags"] = len(tags)

    def stopping(self):
        if self.stop_event.is_set():
            return True
        try:
            if json.loads((self.runtime / "http-control.json").read_text(encoding="utf-8")).get("stop"):
                self.stop_event.set()
        except (OSError, ValueError):
            pass
        return self.stop_event.is_set()

    def unit(self, tag):
        saved = self.store.checkpoint(tag, self.mode)
        if self.resume and saved:
            if saved["state"] != "exhausted":
                return dict(saved, state="pending")
            if self.mode == "full":
                return saved
        watermark = self.store.watermark(tag)
        return {
            "tag": tag, "mode": self.mode, "state": "pending", "cycle": str(uuid.uuid4()),
            "cursor": None, "pages": 0, "last_time": None, "note": "",
            "upper_ms": int(time.time() * 1000),
            "cutoff_ms": max(0, watermark - self.overlap_ms) if self.mode == "incremental" else 0,
        }

    def step(self, state):
        if state["state"] == "exhausted":
            return True
        if self.stopping():
            return True
        with self.lock:
            self.job["current"] = f"#{state['tag']} 第 {state['pages'] + 1} 页"
        page = self.source.page(state["tag"], "works", state["cursor"])
        works = [self.source.row_work(item, "works") for item in page.items]
        times = [
            self.source.parts(item["row"])[0]["publishTime"] for item in page.items
        ]
        if any(a < b for a, b in zip(times, times[1:])) or (
            times and state["last_time"] is not None and times[0] > state["last_time"]
        ):
            raise CollectError("最新标签流发生时间倒序异常或分页重排，未推进断点和增量边界。", "restricted")
        fingerprint = None
        if page.items:
            fingerprint = hashlib.sha256(
                json.dumps([item["id"] for item in page.items]).encode()
            ).hexdigest()
            if self.store.has_page(state["cycle"], fingerprint):
                raise CollectError("标签接口重复返回已处理页面，不能认定已完成。", "restricted")
        for work, timestamp in zip(works, times):
            if self.stopping():
                # 页尾断点还没保存；下次会重放此页，已提交作品按 ID 去重。
                return True
            if timestamp > state["upper_ms"]:
                continue  # 本轮开始后发表的作品留给下一次增量，不推进时间边界。
            hits = self.matcher.attribute(work["tags"])
            if not hits:
                continue
            tags = list(dict.fromkeys(t for group in hits.values() for t in group))
            self.store.put({
                **work, "operatorIds": sorted(hits), "matchedTags": tags,
                "matchScopes": {
                    oid: "qualified" if any(qualified(t) for t in group) else "bare"
                    for oid, group in hits.items()
                },
                "matchReason": "原生标签精确等于角色别名。",
            })
        crossed = bool(times and state["cutoff_ms"] and max(times) < state["cutoff_ms"])
        complete = page.done or crossed
        updated = {
            **state, "cursor": page.cursor, "pages": state["pages"] + 1,
            "last_time": times[-1] if times else state["last_time"],
            "state": "exhausted" if complete else "running",
            "note": "已扫描到增量重叠区间之前。" if crossed else (
                "接口返回结束。" if page.done else ""
            ),
        }
        # 成功边界与页尾断点同一事务提交；任何失败都不能提前推进边界。
        self.store.save(updated, fingerprint, complete)
        state.update(updated)
        return complete

    def worker(self):
        while not self.stopping() and not self.halted.is_set():
            try:
                state = self.queue.get_nowait()
            except queue.Empty:
                with self.lock:
                    idle = self.active == 0
                if idle:
                    return
                time.sleep(0.05)
                continue
            with self.lock:
                self.active += 1
            try:
                done = self.step(state)
                if done:
                    with self.lock:
                        self.job["finishedTags"] += int(state["state"] == "exhausted")
                else:
                    self.queue.put(state)
            except CollectError as error:
                state.update(state=error.kind if error.kind in ("blocked", "restricted", "cancelled") else "failed", note=str(error))
                self.store.save(state)
                with self.lock:
                    self.job["errors"].append(f"#{state['tag']}：{error}")
                if error.kind == "blocked":
                    self.halted.set()  # 会话或平台受阻时停止整个平台，避免把所有标签逐个打失败。
            except Exception as error:
                state.update(state="failed", note=f"处理失败（{type(error).__name__}），保留当前页断点。")
                self.store.save(state)
                with self.lock:
                    self.job["errors"].append(f"#{state['tag']}：{state['note']}")
            finally:
                with self.lock:
                    self.active -= 1

    def run(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        atomic_json(self.runtime / "http-control.json", {"stop": False})
        signal.signal(signal.SIGINT, lambda *_: self.stop_event.set())
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = [executor.submit(self.worker) for _ in range(self.workers)]
            while not all(f.done() for f in futures):
                with self.lock:
                    self.job["requests"] = getattr(self.source, "requests", 0)
                    self.job["workCount"] = self.store.work_count()
                    atomic_json(self.runtime / "http-job.json", self.job)
                time.sleep(2)
        self.job["state"] = "cancelled" if self.stopping() else (
            "completed" if self.job["finishedTags"] == self.job["totalTags"] else "failed"
        )
        self.job["finishedAt"] = now()
        self.job["workCount"] = self.store.work_count()
        atomic_json(self.runtime / "http-job.json", self.job)
        print(f"LOFTER：{self.job['state']}；已保存 {self.job['workCount']} 件去重作品。", flush=True)
        return self.job["state"]
