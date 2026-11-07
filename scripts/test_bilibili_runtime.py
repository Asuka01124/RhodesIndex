"""B 站中文检索范围、运行隔离、受限停止和只读监测。"""
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from tag_collect import Collector, main
from tag_match import Matcher
from tag_store import Store, atomic_json
from tag_session import CollectError
from collector_sources.bilibili import Bilibili
from pixiv_watch import snapshot
import platform_entry

ROOT = Path(__file__).resolve().parents[1]


class BilibiliRuntimeTests(unittest.TestCase):
    def test_bilibili_counts_defaults_to_single_worker_and_low_frequency(self):
        from contextlib import nullcontext
        with patch("bilibili_collect.run_lock", return_value=nullcontext()), patch("bilibili_collect.BilibiliCountCollector") as collector:
            collector.return_value.run.return_value = "completed"
            platform_entry.run("bilibili", ["collect"])
            self.assertEqual(len(collector.call_args.args[0]), 434)
            self.assertEqual(collector.call_args.kwargs["interval"], 1.5)
            self.assertTrue(collector.call_args.kwargs["resume"])

    def test_legacy_work_collector_does_not_offer_bilibili(self):
        from tag_sources import SOURCES
        self.assertNotIn("bilibili", SOURCES)

    def test_old_high_frequency_settings_are_rejected(self):
        from bilibili_collect import main as count_main
        for args in [["--interval", "0.01"], ["--workers", "6"], ["--interval", "nan"], ["--interval", "inf"]]:
            with self.subTest(args=args), patch("sys.stderr", new=io.StringIO()):
                with self.assertRaises(SystemExit), patch("bilibili_collect.BilibiliCountCollector") as collector:
                    count_main(["collect"] + args)
                collector.assert_not_called()

    def response(self):
        return {"code": 0, "data": {
            "View": {"bvid": "BVexample", "title": "示例", "pubdate": 1735689600,
                     "stat": {"like": 0, "view": 1234, "favorite": 56}},
            "Tags": [{"tag_name": "黍"}, {"tag_name": "明日方舟"}],
        }}

    def test_one_request_preserves_tags_metrics_zero_and_provenance(self):
        source = Bilibili.__new__(Bilibili)
        source.session = Mock()
        source.session.json.return_value = self.response()
        work = source.detail({"id": "BVexample"}, "works")
        self.assertEqual(source.session.json.call_count, 1)
        self.assertEqual(work["tags"], ["黍", "明日方舟"])
        self.assertEqual((work["likes"], work["views"]), (0, 1234))
        self.assertEqual(work["nativeMetrics"], {"like": 0, "view": 1234, "favorite": 56})
        self.assertEqual(work["url"], "https://www.bilibili.com/video/BVexample/")
        self.assertEqual(work["publishedAt"], "2025-01-01T00:00:00+00:00")
        self.assertTrue(work["observedAt"])

    def test_missing_or_malformed_native_tags_cannot_be_counted_as_empty(self):
        for tags in [None, {}, ["黍"], [{"tag_name": None}]]:
            with self.subTest(tags=tags):
                body = self.response()
                body["data"]["Tags"] = tags
                source = Bilibili.__new__(Bilibili)
                source.session = Mock()
                source.session.json.return_value = body
                with self.assertRaises(CollectError):
                    source.detail({"id": "BVexample"}, "works")

    def test_detail_for_another_video_is_rejected(self):
        source = Bilibili.__new__(Bilibili)
        source.session = Mock()
        source.session.json.return_value = self.response()
        with self.assertRaises(CollectError):
            source.detail({"id": "BVdifferent"}, "works")

    def test_all_434_operators_have_exactly_one_chinese_query(self):
        roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
        collector = Collector.__new__(Collector)
        collector.operators = roster
        collector.matcher = Matcher(roster)
        collector.primary_only = True
        units = collector.units(Bilibili.__new__(Bilibili))
        self.assertEqual(len(units), 434)
        self.assertEqual({u["operator"]["id"] for u in units}, {o["id"] for o in roster})
        self.assertTrue(all(u["tag"] == u["operator"]["name"] for u in units))
        collector.primary_only = False
        self.assertGreater(len(collector.units(Bilibili.__new__(Bilibili))), 434)

    def test_bilibili_stop_does_not_stop_pixiv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_json(root / "http-control.json", {"stop": False})
            with patch("bilibili_collect.RUNTIME", root / "bilibili"):
                platform_entry.run("bilibili", ["stop"])
            self.assertFalse(json.loads((root / "http-control.json").read_text())["stop"])
            self.assertTrue(json.loads((root / "bilibili/http-control.json").read_text())["stop"])

    def test_pixiv_stop_does_not_stop_bilibili_and_blocked_halts_bilibili(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_json(root / "http-control.json", {"stop": True})
            runtime = root / "bilibili"
            atomic_json(runtime / "http-control.json", {"stop": False})
            roster = [{"id": "shu", "name": "黍", "englishName": "Shu"}]
            store = Store(root)
            with patch("tag_collect.Store", return_value=store), patch("tag_collect.LOCAL", root):
                collector = Collector(["bilibili"], roster, runtime=runtime,
                                      primary_only=True, halt_on_blocked=True)
                self.assertFalse(collector.stopping())
                unit = collector.units(Bilibili.__new__(Bilibili))[0]
                collector.load_checkpoint(None, unit)
                collector.fail(unit, CollectError("接口验证受限", "blocked"))
                self.assertTrue(collector.stopping())
                state = store.db.execute("SELECT state FROM queries").fetchone()[0]
                self.assertEqual(state, "blocked")
            store.db.close()

    def test_monitor_reads_bilibili_counts_and_separate_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root)
            for platform in ["bilibili", "pixiv"]:
                store.put({"id": "one", "platform": platform, "operatorIds": ["shu"],
                           "observedAt": "2026-11-02T00:00:00Z"})
            store.queue_metric("pixiv", "one", "artworks")
            atomic_json(root / "http-job.json", {"id": "pixiv-job"})
            atomic_json(root / "bilibili/http-job.json", {"id": "bilibili-job"})
            works, pending, _, job, _ = snapshot(root, "bilibili")
            self.assertEqual((works, pending, job["id"]), (1, 0, "bilibili-job"))
            self.assertEqual(snapshot(root)[3]["id"], "pixiv-job")
            store.db.close()

    def test_detail_risk_control_code_is_not_an_empty_or_missing_work(self):
        source = Bilibili.__new__(Bilibili)
        class Http:
            def json(self, method, url, **kwargs):
                return {"code": -352}
        source.session = Http()
        with self.assertRaises(CollectError) as caught:
            source.detail({"id": "sample"}, "works")
        self.assertEqual(caught.exception.kind, "blocked")


if __name__ == "__main__":
    unittest.main()
