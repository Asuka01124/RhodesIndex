"""B站多标签交集数量，复用带事务的标签存储和可恢复调度。"""

import json

from collector_sources.bilibili_intersections import BilibiliIntersections
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import LOCAL
from bilibili_count_export import export_counts


RUNTIME = LOCAL / "bilibili"


class BilibiliCountCollector(TagStatsCollector):
    kind = "tag_intersection_count"
    label = "哔哩哔哩"

    def __init__(self, operators, *, interval=3.5, resume=True, store=None,
                 source=None, runtime=RUNTIME):
        super().__init__(
            operators, workers=1, interval=interval, resume=resume, primary_only=True,
            store=store if store is not None else TagStatsStore(platform="bilibili"),
            source=source if source is not None else BilibiliIntersections(operators, interval), runtime=runtime,
        )
        if isinstance(self.source, BilibiliIntersections):
            self.source.bind(self.store, self.job["id"])
            self.source.on_progress = self.progress

    def progress(self, observation):
        item = next(item for item in self.plan if item["tag"] == observation["tag"])
        record = {**observation, "operatorIds": item["operatorIds"], "scope": "tag_intersection"}
        with self.store.lock:
            self.store.db.execute("INSERT OR REPLACE INTO bilibili_tag_stats VALUES(?,?)",
                                  (item["key"], json.dumps(record, ensure_ascii=False)))
            self.store.db.execute("UPDATE bilibili_tag_queue SET state='running',note='' WHERE run_id=? AND tag_key=?",
                                  (self.job["id"], item["key"]))
            self.store.db.commit()
        with self.lock:
            self.job["lastObservation"] = record
        self.publish()

    def run(self):
        state = super().run()
        if state == "completed":
            with self.store.lock:
                records = [json.loads(row[0]) for row in self.store.db.execute(
                    "SELECT data FROM bilibili_tag_history WHERE run_id=?", (self.job["id"],))]
            if any(row.get("countBasis") == "exact_tag_intersection" and not row.get("complete") for row in records):
                self.job["state"] = "partial"
                self.publish()
                state = "partial"
        return state

    def publish(self):
        super().publish()
        # 只为正式项目导出网站数据，隔离测试和外部数据库不写入项目快照。
        if self.store.directory == LOCAL and self.runtime == RUNTIME:
            latest = self.job.get("lastObservation") or {}
            signature = (self.job["state"], self.job["requests"], self.job["processedTags"],
                         latest.get("observedAt"), str(self.job.get("errors", [])[-1:]))
            if signature != getattr(self, "_exported_signature", None):
                export_counts()
                self._exported_signature = signature
