"""组合搜索总数的分段、防重复、断点与新旧口径隔离。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from bilibili_search_export import export_counts
from bilibili_search_runtime import BilibiliSearchCollector
from collector_sources.bilibili_search_totals import BilibiliSearchTotals
from lofter_tag_stats import TagStatsStore
from tag_session import CollectError
from tag_store import atomic_json


OP = {"id": "alice", "name": "爱丽丝"}


def body(total, date=20):
    return {"code": 0, "data": {"numResults": total, "result": [{"pubdate": date}] if total else []}}


class SearchTotalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = TagStatsStore(self.root, "bilibili")

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def source(self, responses, operators=None):
        with patch("collector_sources.bilibili_search_totals.Session"), patch("collector_sources.bilibili_search_totals.time.time", return_value=20):
            source = BilibiliSearchTotals(operators or [OP])
        source.bind(self.store, "run")
        source.session.json.side_effect = responses
        return source

    def test_one_request_reads_total_without_counting_or_filtering_video_tags(self):
        source = self.source([body(800)])
        result = source.read("爱丽丝")
        self.assertEqual(result["workCount"], 800)
        self.assertEqual(source.requests, 1)
        self.assertEqual(result["query"], "爱丽丝 明日方舟")
        self.assertEqual(result["nativeMetrics"]["windowCounts"][0]["numResults"], 800)
        self.assertEqual(result["countBasis"], "search_result_total")
        self.assertTrue(result["complete"])
        self.assertIsNone(result["publishedAt"])
        self.assertNotIn("requiredTagGroups", result)
        self.assertEqual(source.session.json.call_args.kwargs["params"]["page"], 1)

    def test_capped_total_splits_nonoverlapping_windows_and_sums_native_subtotals(self):
        source = self.source([body(1000), body(600), body(650, 10)])
        with patch("collector_sources.bilibili_search_totals.time.time", return_value=20):
            result = source.read("爱丽丝")
        self.assertEqual(result["workCount"], 1250)
        self.assertTrue(result["complete"])
        intervals = [(window["begin"], window["end"]) for window in result["nativeMetrics"]["windowCounts"]]
        self.assertEqual(intervals, [(11, 20), (1, 10)])
        self.assertEqual(source.requests, 3)
        self.assertTrue(all(call.kwargs["params"]["page"] == 1 for call in source.session.json.call_args_list))

    def test_cancel_resume_does_not_recount_committed_subtotals(self):
        source = self.source([body(1000), body(600)])
        source.on_progress = lambda record: setattr(source, "cancelled", lambda: record["countedWindows"] > 0)
        with patch("collector_sources.bilibili_search_totals.time.time", return_value=20), self.assertRaises(CollectError):
            source.read("爱丽丝")
        resumed = self.source([body(650, 10)])
        result = resumed.read("爱丽丝")
        self.assertEqual(result["workCount"], 1250)
        self.assertEqual(resumed.requests, 1)

    def test_real_zero_is_preserved_without_a_result_list(self):
        source = self.source([{"code": 0, "data": {"numResults": 0}}])
        result = source.read("爱丽丝")
        self.assertEqual(result["workCount"], 0)
        self.assertTrue(result["complete"])

    def test_missing_or_invalid_totals_do_not_become_zero(self):
        for value in [None, True, -1, "1000+"]:
            source = self.source([{"code": 0, "data": {"numResults": value}}])
            with self.subTest(value=value), self.assertRaises(CollectError):
                source.read("爱丽丝")

    def test_ignored_time_filter_is_rejected(self):
        source = self.source([body(5, date=999)])
        with patch("collector_sources.bilibili_search_totals.time.time", return_value=20), self.assertRaisesRegex(CollectError, "时间"):
            source.read("爱丽丝")

    def test_auth_error_stops_without_saving_false_data(self):
        source = self.source([{"code": -352}])
        with self.assertRaises(CollectError) as caught:
            source.read("爱丽丝")
        self.assertEqual(caught.exception.kind, "blocked")
        self.assertEqual(source.requests, 1)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM bilibili_search_progress").fetchone()[0], 0)

    def test_single_second_cap_is_reported_as_lower_bound(self):
        source = self.source([body(1000, 1)])
        source.save("爱丽丝", {"queryHash": __import__("hashlib").sha256("爱丽丝 明日方舟".encode()).hexdigest(), "windows": [[1, 1]], "windowCounts": [], "requests": 0, "observedAt": None, "truncated": False, "rootNumResults": None})
        result = source.read("爱丽丝")
        self.assertFalse(result["complete"])
        self.assertTrue(result["lowerBound"])
        self.assertEqual(result["workCount"], 1000)

    def test_collaboration_query_includes_canonical_work_name(self):
        operator = {"id": "char_456_ash", "name": "灰烬"}
        source = self.source([body(7)], [operator])
        result = source.read("灰烬")
        self.assertEqual(result["query"], "灰烬 明日方舟 彩虹六号")
        self.assertEqual(source.requests, 1)

    def test_new_mode_does_not_resume_old_intersection_batch(self):
        runtime = self.root / "bilibili"
        old = {"id": "old", "kind": "tag_intersection_count", "state": "cancelled"}
        atomic_json(runtime / "http-job.json", old)
        source = Mock(requests=0)
        collector = BilibiliSearchCollector([OP], store=self.store, source=source, runtime=runtime)
        self.assertNotEqual(collector.job["id"], "old")
        self.assertEqual(collector.job["kind"], "search_result_count")


class SearchExportTests(unittest.TestCase):
    def test_export_excludes_old_counts_and_preserves_zero_and_forms(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            roster = [OP, {"id": "medical", "name": "阿米娅(医疗)"}]
            atomic_json(root / "public/data/operators.json", roster)
            store = TagStatsStore(root / ".local", "bilibili")
            try:
                for operator, basis in [(OP, "search_result_total"), (roster[1], "exact_tag_intersection")]:
                    store.put("new", {"key": operator["name"], "operatorIds": [operator["id"]], "scope": "combined_search"}, {
                        "tag": operator["name"], "workCount": 0, "countBasis": basis,
                        "query": operator["name"] + " 明日方舟", "searchTerms": [operator["name"], "明日方舟"],
                        "complete": True, "observedAt": "2026-11-03T00:00:00Z"})
                data = export_counts(root)
                self.assertEqual([row["workCount"] for row in data["records"]], [0, None])
                self.assertEqual(data["metadata"]["countBasis"], "search_result_total")
                self.assertEqual(data["metadata"]["availableTags"], 1)
                self.assertNotIn("requiredTagGroups", data["records"][0])
                self.assertTrue((root / "public/data/bilibili-tag-counts.json").exists())
            finally:
                store.db.close()


if __name__ == "__main__":
    unittest.main()
