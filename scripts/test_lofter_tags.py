"""标签统计的定位、显示精度、恢复和定向删除验证。"""

import json
from contextlib import closing, nullcontext
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from collector_sources.lofter_tags import LofterTags, TagHeader, display_count
from lofter_cleanup import clean_snapshot, purge_database, reset_project
from lofter_tag_stats import TagStatsCollector, TagStatsStore, make_plan
from tag_session import CollectError
from tag_store import Store


HEADER = '<nav>0参与 5浏览</nav><div class="tag-count f-fl">861.8万浏览&nbsp;&nbsp;45771参与</div>'
OP = {"id": "lappland", "name": "拉普兰德", "englishName": "Lappland", "japaneseName": "ラップランド"}


class TagHeaderTests(unittest.TestCase):
    def parse(self, html):
        parser = TagHeader()
        parser.feed(html)
        return parser.result()

    def test_uses_header_and_ignores_navigation_and_other_counts(self):
        views, participation = self.parse(HEADER)
        self.assertEqual(views, {"display": "861.8万", "exact": False, "value": None, "estimate": 8618000, "atLeast": None})
        self.assertTrue(participation["exact"])
        self.assertEqual(participation["value"], 45771)

    def test_supports_nested_spans_and_preserves_real_zero(self):
        views, participation = self.parse('<div class="tag-count"><span>0</span>浏览 <b>0</b>参与</div>')
        self.assertEqual(views["value"], 0)
        self.assertEqual(participation["value"], 0)

    def test_missing_header_is_not_zero(self):
        with self.assertRaises(CollectError):
            self.parse('<h1>请登录</h1><script>861.8万浏览 45771参与</script>')

    def test_conflicting_headers_are_not_silently_merged(self):
        with self.assertRaises(CollectError):
            self.parse(HEADER + '<div class="tag-count">1浏览2参与</div>')

    def test_large_units_and_plus_are_explicitly_approximate(self):
        self.assertEqual(display_count("2.6亿")["estimate"], 260000000)
        self.assertIsNone(display_count("2.6亿")["value"])
        self.assertEqual(display_count("10万+")["atLeast"], 100000)
        self.assertEqual(display_count("1,234")["value"], 1234)

    def test_invalid_counts_are_rejected(self):
        for text in ["暂无", "-1", "1.2", "12,34", "NaN"]:
            with self.subTest(text=text), self.assertRaises(CollectError):
                display_count(text)

    def test_source_only_requests_the_tag_page(self):
        with patch("tag_session.load_cookies", return_value={}), patch("tag_session.system_proxy", return_value={}):
            source = LofterTags()
        response = Mock(status_code=200, headers={"Content-Type": "text/html"}, text=HEADER)
        source.session.request = Mock(return_value=response)
        result = source.read("拉普兰德")
        self.assertEqual(result["kind"], "tag_summary")
        self.assertEqual(source.session.request.call_args.args[0], "GET")
        self.assertIn("/tag/", source.session.request.call_args.args[1])
        self.assertNotIn("api", source.session.request.call_args.args[1])
        self.assertEqual(source.session.request.call_count, 1)

    def test_wall_redirect_is_recorded_as_unavailable_not_zero(self):
        with patch("tag_session.load_cookies", return_value={}), patch("tag_session.system_proxy", return_value={}):
            source = LofterTags()
        source.session.request = Mock(return_value=Mock(status_code=302, headers={"Location": "https://www.lofter.com/wall"}))
        result = source.read("明日方舟CONFESS-47")
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["views"]["value"])
        self.assertIsNone(result["participation"]["display"])


class TagStoreTests(unittest.TestCase):
    def test_default_plan_contains_only_434_chinese_primary_tags(self):
        roster = json.loads((Path(__file__).resolve().parents[1] / "public/data/operators.json").read_text(encoding="utf-8"))
        plan = make_plan(roster)
        self.assertEqual(len(plan), 434)
        self.assertEqual({item["tag"] for item in plan}, {o["name"] for o in roster})
        with patch("lofter_collect.run_lock", return_value=nullcontext()), patch("lofter_collect.TagStatsCollector") as collector:
            from lofter_collect import main
            collector.return_value.run.return_value = "completed"
            main(["collect"])
            self.assertTrue(collector.call_args.args[5])
            self.assertEqual(len(collector.call_args.args[0]), 434)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = TagStatsStore(self.root)

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def collector(self, **kwargs):
        kwargs.setdefault("primary_only", False)
        source = Mock()
        source.requests = 0
        source.read.side_effect = lambda tag: {"platform": "lofter", "kind": "tag_summary", "tag": tag,
                                              "views": display_count("1.2万"), "participation": display_count("20"),
                                              "observedAt": "2026-11-02T00:00:00+00:00"}
        return TagStatsCollector([OP], store=self.store, source=source, runtime=self.root / "runtime", **kwargs)

    def test_all_language_and_prefix_aliases_are_preserved(self):
        plan = make_plan([OP], primary_only=False)
        self.assertEqual(len(plan), 6)
        self.assertIn("明日方舟Lappland", {i["tag"] for i in plan})
        self.assertEqual(len(make_plan([OP], primary_only=True)), 1)

    def test_tags_are_saved_separately_and_not_added_into_work_rows(self):
        collector = self.collector()
        collector.worker()
        rows = self.store.db.execute("SELECT data FROM lofter_tag_stats").fetchall()
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(json.loads(r[0])["views"]["value"] is None for r in rows))
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM sqlite_master WHERE name='works'").fetchone())

    def test_unfinished_batch_resumes_only_unfinished_tags(self):
        collector = self.collector()
        item = collector.queue.get_nowait()
        self.store.put(collector.job["id"], item, collector.source.read(item["tag"]))
        collector.job["state"] = "cancelled"
        collector.publish()
        resumed = self.collector()
        self.assertEqual(resumed.job["id"], collector.job["id"])
        self.assertEqual(resumed.queue.qsize(), 5)

    def test_completed_batch_starts_a_new_snapshot_on_next_collection(self):
        collector = self.collector()
        collector.worker()
        collector.job["state"] = "completed"
        collector.publish()
        refreshed = self.collector()
        self.assertNotEqual(refreshed.job["id"], collector.job["id"])
        self.assertEqual(refreshed.queue.qsize(), 6)

    def test_failed_read_preserves_previous_good_stats(self):
        collector = self.collector(primary_only=True)
        collector.worker()
        self.store.fail("later-run", "拉普兰德", "failed", "页面异常")
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM lofter_tag_stats").fetchone()[0], 1)
        self.assertFalse(self.store.done("later-run"))


class CleanupTests(unittest.TestCase):
    def test_full_reset_clears_lofter_stats_history_and_queue_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work_store = Store(root)
            for platform in ("pixiv", "lofter"):
                work_store.put({"id": "one", "platform": platform, "operatorIds": ["op"]})
            work_store.db.close()
            item = {"key": "拉普兰德", "operatorIds": ["op"], "scope": "bare"}
            for platform in ("lofter", "bilibili"):
                store = TagStatsStore(root, platform)
                store.put("old", item, {"platform": platform, "tag": item["key"], "workCount": 7})
                store.db.close()
            result = purge_database(root / "http-collection.sqlite", clear_tag_stats=True)
            self.assertEqual(result["removedWorks"], 1)
            self.assertEqual(result["lofter_tag_stats"], 1)
            with closing(sqlite3.connect(root / "http-collection.sqlite")) as db:
                for table in ("stats", "history", "queue"):
                    self.assertEqual(db.execute(f"SELECT count(*) FROM lofter_tag_{table}").fetchone()[0], 0)
                    self.assertEqual(db.execute(f"SELECT count(*) FROM bilibili_tag_{table}").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT key FROM works").fetchall(), [("pixiv:one",)])

    def test_project_reset_removes_old_snapshots_and_prepares_primary_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_json = __import__("tag_store").atomic_json
            atomic_json(root / ".local/observations.json", {"works": [
                {"platform": "lofter"}, {"platform": "pixiv"}]})
            report = reset_project(root)
            self.assertEqual(report["snapshots"][0]["removed"]["works"], 1)
            job = json.loads((root / ".local/lofter/http-job.json").read_text(encoding="utf-8"))
            self.assertEqual((job["scope"], job["totalTags"], job["state"]), ("primary", 434, "pending"))
            saved = json.loads((root / ".local/observations.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["works"], [{"platform": "pixiv"}])

    def test_deletes_only_lofter_and_preserves_other_platform_data(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            for platform in ("pixiv", "lofter"):
                store.put({"id": "1", "platform": platform, "operatorIds": ["op"],
                           "likes": 0, "views": None, "nativeMetrics": {}, "tags": [], "missing": {}})
                store.query(platform, platform, "op", "tag", "works", False)
                store.seen(platform, "1")
                store.fault(platform, "1", "error")
                store.queue_metric(platform, "1", "works")
                store.coverage({"platform": platform, "operatorId": "op"})
            store.db.close()
            path = Path(directory) / "http-collection.sqlite"
            report = purge_database(path)
            self.assertEqual(report["removedWorks"], 1)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT key FROM works").fetchall(), [("pixiv:1",)])
                for table in ("queries", "coverage", "metrics", "work_operators"):
                    self.assertEqual(db.execute(f"SELECT DISTINCT platform FROM {table}").fetchall(), [("pixiv",)])
                self.assertEqual(db.execute("SELECT query_key FROM seen").fetchall(), [("pixiv",)])
                self.assertEqual(db.execute("SELECT query_key FROM faults").fetchall(), [("pixiv",)])

    def test_snapshot_cleanup_keeps_other_platforms_and_input_unchanged(self):
        old = {"works": [{"platform": "pixiv", "operatorIds": ["one"]},
                         {"platform": "lofter", "operatorIds": ["two"]}],
               "records": [{"platform": "lofter"}], "coverage": [{"platform": "lofter"}],
               "metadata": {"workCount": 2, "platformCount": 2}}
        new, removed = clean_snapshot(old)
        self.assertEqual(removed, {"works": 1, "records": 1, "coverage": 1})
        self.assertEqual(new["metadata"]["workCount"], 1)
        self.assertEqual(len(old["works"]), 2)


if __name__ == "__main__":
    unittest.main()
