"""B站组合搜索计数的独立批次，复用事务队列，保留旧交集历史。"""

import json

from bilibili_search_export import export_counts
from collector_sources.bilibili_search_totals import BilibiliSearchTotals
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import LOCAL


RUNTIME = LOCAL / "bilibili"


class BilibiliSearchCollector(TagStatsCollector):
    kind = "search_result_count"
    label = "哔哩哔哩搜索"

    def __init__(self, operators, *, interval=3.5, resume=True, store=None, source=None, runtime=RUNTIME):
        plan = [{"key": operator["name"], "tag": operator["name"], "operatorIds": [operator["id"]], "scope": "combined_search"} for operator in operators]
        super().__init__(operators, workers=1, interval=interval, resume=resume, primary_only=True,
                         store=store if store is not None else TagStatsStore(platform="bilibili"),
                         source=source if source is not None else BilibiliSearchTotals(operators, interval),
                         runtime=runtime, plan=plan)
        if isinstance(self.source, BilibiliSearchTotals):
            self.source.bind(self.store, self.job["id"])
            self.source.on_progress = self.progress

    def progress(self, observation):
        item = next(item for item in self.plan if item["tag"] == observation["tag"])
        record = {**observation, "operatorIds": item["operatorIds"], "scope": "combined_search"}
        with self.store.lock:
            try:
                self.store.db.execute("INSERT OR REPLACE INTO bilibili_tag_stats VALUES(?,?)", (item["key"], json.dumps(record, ensure_ascii=False)))
                self.store.db.execute("INSERT OR REPLACE INTO bilibili_tag_queue VALUES(?,?,?,?)", (self.job["id"], item["key"], "running", ""))
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        with self.lock:
            self.job["lastObservation"] = record
        self.publish()

    def run(self):
        state = super().run()
        if state == "completed":
            with self.store.lock:
                records = [json.loads(row[0]) for row in self.store.db.execute("SELECT data FROM bilibili_tag_history WHERE run_id=?", (self.job["id"],))]
            if any(not row.get("complete") for row in records):
                self.job["state"] = "partial"
                self.publish()
                state = "partial"
        return state

    def publish(self):
        super().publish()
        if self.store.directory == LOCAL and self.runtime == RUNTIME:
            latest = self.job.get("lastObservation") or {}
            signature = (self.job["state"], self.job["requests"], self.job["processedTags"], latest.get("observedAt"), str(self.job.get("errors", [])[-1:]))
            if signature != getattr(self, "_exported_signature", None):
                export_counts()
                self._exported_signature = signature
