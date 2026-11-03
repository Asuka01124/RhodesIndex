"""批量任务验证：中文主标签、缺失覆盖、断点和平台隔离。"""

from contextlib import nullcontext
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import douyin_collect
from douyin_topic_runtime import DouyinTopicCollector, DouyinTopicStore, make_topic_plan, reconcile_topic_mapping
from lofter_tag_stats import TagStatsStore
from tag_session import CollectError
from tag_store import atomic_json


OPS = [{"id": "amiya", "name": "阿米娅", "englishName": "Amiya"},
       {"id": "amiya2", "name": "阿米娅(近卫)", "englishName": "Amiya"}]


class DouyinRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = DouyinTopicStore(self.root)

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def collector(self, source=None, **kwargs):
        if source is None:
            source = Mock(requests=0)
            source.read.side_effect = lambda tag: {"platform": "douyin", "tag": tag, "status": "ok", "playCount": 0}
        return DouyinTopicCollector(OPS, store=self.store, source=source, runtime=self.root / "douyin", **kwargs)

    def test_primary_names_do_not_mix_operator_forms_or_expand_aliases(self):
        plan = make_topic_plan(OPS)
        self.assertEqual(len(plan), 2)
        self.assertEqual(plan[0]["operatorIds"], ["amiya"])
        self.assertEqual(plan[1]["operatorIds"], ["amiya2"])
        self.assertEqual({item["tag"] for item in plan}, {operator["name"] for operator in OPS})

    def test_amiya_forms_query_one_shared_topic_without_summing(self):
        operators = [{"id": "char_002_amiya", "name": "阿米娅"},
                     {"id": "char_1001_amiya2", "name": "阿米娅(近卫)"},
                     {"id": "char_1037_amiya3", "name": "阿米娅(医疗)"}]
        source = Mock(requests=0)
        source.read.return_value = {"platform": "douyin", "tag": "阿米娅", "status": "ok", "playCount": 17}
        collector = DouyinTopicCollector(operators, store=self.store, source=source, runtime=self.root / "douyin")
        collector.worker()
        collector.publish()
        source.read.assert_called_once_with("阿米娅")
        snapshot = json.loads((self.root / "douyin/topic-counts.json").read_text(encoding="utf-8"))
        self.assertEqual(len(snapshot["records"]), 1)
        self.assertEqual(snapshot["records"][0]["playCount"], 17)
        self.assertEqual(len(snapshot["records"][0]["operatorIds"]), 3)
        self.assertEqual(collector.job["completedOperators"], 3)
        self.assertEqual((collector.job["totalOperators"], collector.job["totalTags"]), (3, 1))

    def test_offline_remap_preserves_raw_count_time_and_old_history(self):
        operators = [{"id": "char_002_amiya", "name": "阿米娅"},
                     {"id": "char_1001_amiya2", "name": "阿米娅(近卫)"},
                     {"id": "char_1037_amiya3", "name": "阿米娅(医疗)"}]
        runtime = self.root / "douyin"
        for operator in operators[:2]:
            self.store.put("old", {"key": operator["name"], "operatorIds": [operator["id"]], "scope": "old"}, {
                "platform": "douyin", "tag": operator["name"], "status": "ok", "playCount": 17 if operator is operators[0] else 0,
                "topicId": "123", "observedAt": "2026-11-03T00:00:00Z", "native": {"view_count": 17 if operator is operators[0] else 0}})
        self.store.fail("old", "阿米娅(医疗)", "failed", "未取得")
        atomic_json(runtime / "http-job.json", {"id": "old", "kind": "douyin_topic_summary", "state": "failed"})
        with patch("douyin_topic_runtime.DouyinTopics") as network:
            job = reconcile_topic_mapping(operators, self.store, runtime)
        network.assert_not_called()
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["requests"], 0)
        self.assertEqual(job["reusedTags"], 1)
        snapshot = json.loads((runtime / "topic-counts.json").read_text(encoding="utf-8"))
        record = snapshot["records"][0]
        self.assertEqual(record["playCount"], 17)
        self.assertEqual(record["observedAt"], "2026-11-03T00:00:00Z")
        self.assertEqual(record["native"]["view_count"], 17)
        self.assertEqual(record["reusedFromRun"], "old")
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM douyin_tag_history WHERE run_id='old'").fetchone()[0], 2)

    def test_full_roster_has_434_entries_but_432_distinct_topics_after_amiya_mapping(self):
        roster = json.loads((Path(__file__).resolve().parents[1] / "public/data/operators.json").read_text(encoding="utf-8"))
        plan = make_topic_plan(roster)
        self.assertEqual(len(plan), 432)
        self.assertEqual(len(next(item for item in plan if item["tag"] == "阿米娅")["operatorIds"]), 3)

    def test_default_cli_selects_all_434_and_preserves_resume(self):
        with patch.object(douyin_collect, "run_lock", return_value=nullcontext()), patch.object(douyin_collect, "DouyinTopicCollector") as factory:
            factory.return_value.run.return_value = "completed"
            self.assertEqual(douyin_collect.main(["collect"]), 0)
        self.assertEqual(len(factory.call_args.args[0]), 434)
        self.assertTrue(factory.call_args.kwargs["resume"])
        self.assertEqual(factory.call_args.kwargs["interval"], 3.5)

    def test_interrupted_batch_resumes_only_remaining_tags(self):
        first = self.collector()
        item = first.queue.get_nowait()
        self.store.put(first.job["id"], item, first.source.read(item["tag"]))
        first.job["state"] = "cancelled"
        first.publish()
        resumed = self.collector()
        self.assertEqual(resumed.job["id"], first.job["id"])
        self.assertEqual(resumed.queue.qsize(), 1)
        self.assertEqual(resumed.job["processedTags"], 1)

    def test_missing_count_is_processed_but_not_readable(self):
        source = Mock(requests=0)
        source.read.side_effect = lambda tag: {"platform": "douyin", "tag": tag, "status": "partial", "playCount": None}
        collector = self.collector(source)
        collector.worker()
        collector.publish()
        self.assertEqual(collector.job["processedTags"], 2)
        self.assertEqual(collector.job["completedTags"], 0)
        self.assertEqual(collector.job["unavailableTags"], 2)
        records = json.loads((self.root / "douyin/topic-counts.json").read_text(encoding="utf-8"))["records"]
        self.assertTrue(all(record["playCount"] is None for record in records))

    def test_blocked_response_stops_further_tags_and_keeps_old_success(self):
        first = self.collector()
        first.worker()
        source = Mock(requests=0)
        source.read.side_effect = CollectError("会话验证受限", "blocked")
        second = self.collector(source, resume=False)
        second.worker()
        self.assertEqual(source.read.call_count, 1)
        self.assertTrue(second.halted.is_set())
        self.assertEqual(len(self.store.done(second.job["id"])), 0)
        saved = [json.loads(row[0]) for row in self.store.db.execute("SELECT data FROM douyin_tag_stats")]
        self.assertEqual(len(saved), 2)
        self.assertTrue(all(row["playCount"] == 0 for row in saved))

    def test_snapshot_contains_only_current_run(self):
        previous = self.collector()
        previous.worker()
        current = self.collector(resume=False)
        item = current.queue.get_nowait()
        self.store.put(current.job["id"], item, current.source.read(item["tag"]))
        current.publish()
        snapshot = json.loads((self.root / "douyin/topic-counts.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["metadata"]["runId"], current.job["id"])
        self.assertEqual(len(snapshot["records"]), 1)

    def test_stop_control_prevents_new_requests(self):
        collector = self.collector()
        atomic_json(self.root / "douyin/http-control.json", {"stop": True})
        collector.worker()
        collector.source.read.assert_not_called()

    def test_platform_storage_isolation(self):
        item = make_topic_plan(OPS)[0]
        other = TagStatsStore(self.root, "bilibili")
        try:
            other.put("bili", item, {"platform": "bilibili", "workCount": 7})
            collector = self.collector()
            collector.worker()
            self.assertEqual(json.loads(other.db.execute("SELECT data FROM bilibili_tag_stats").fetchone()[0])["workCount"], 7)
            self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM douyin_tag_stats").fetchone()[0], 2)
        finally:
            other.db.close()


if __name__ == "__main__":
    unittest.main()
