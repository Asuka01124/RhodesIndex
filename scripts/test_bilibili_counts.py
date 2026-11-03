"""标签数量的原生口径、缺失值、断点、平台隔离及旧数据清理。"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from bilibili_cleanup import clean_snapshot, purge_database, other_platform_fingerprint
from bilibili_count_runtime import BilibiliCountCollector
from bilibili_count_export import count_snapshot, export_counts
from collector_sources.bilibili_counts import BilibiliCounts
from lofter_tag_stats import TagStatsStore
from lofter_watch import snapshot
from tag_session import CollectError
from tag_store import Store, atomic_json


OPS = [{"id": "shu", "name": "黍", "englishName": "Shu", "japaneseName": "シュウ"},
       {"id": "ling", "name": "令", "englishName": "Ling"}]


class BilibiliCountSourceTests(unittest.TestCase):
    def test_fullwidth_parentheses_are_retried_without_merging_operator_forms(self):
        source = self.source({})
        source.session.json.side_effect = [
            {"code": 16001},
            {"code": 0, "data": {"tag_id": 61298435, "tag_name": "阿米娅（医疗）", "count": {"use": 3}}},
        ]
        row = source.read("阿米娅(医疗)")
        self.assertEqual((row["tag"], row["nativeTag"], row["workCount"]), ("阿米娅(医疗)", "阿米娅（医疗）", 3))
        self.assertEqual(source.requests, 2)
        self.assertEqual(source.session.json.call_args.kwargs["params"], {"tag_name": "阿米娅（医疗）"})

    def test_missing_medical_tag_never_uses_the_base_amiya_count(self):
        source = self.source({})
        source.session.json.side_effect = [{"code": 16001}, self.body(95414)]
        with self.assertRaises(CollectError):
            source.read("阿米娅(医疗)")

    def source(self, body):
        with patch("collector_sources.bilibili_counts.Session"):
            source = BilibiliCounts()
        source.session.json.return_value = body
        return source

    def body(self, count=29768):
        return {"code": 0, "data": {"tag_id": 123, "tag_name": "黍",
                                    "count": {"use": count, "view": 0, "atten": 4}}}

    def test_one_request_gets_native_total_with_sources_and_no_fake_year(self):
        source = self.source(self.body())
        row = source.read("黍")
        source.session.json.assert_called_once()
        self.assertEqual(source.session.json.call_args.kwargs["params"], {"tag_name": "黍"})
        self.assertEqual(row["workCount"], 29768)
        self.assertEqual(row["nativeMetrics"]["count.use"], 29768)
        self.assertEqual(row["nativeMetrics"]["count"]["atten"], 4)
        self.assertIsNone(row["annualCounts"])
        self.assertIsNone(row["year"])
        self.assertIsNone(row["publishedAt"])
        self.assertTrue(row["observedAt"])
        self.assertIn("api.bilibili.com/x/tag/info", row["apiSourceUrl"])

    def test_real_zero_is_preserved(self):
        self.assertEqual(self.source(self.body(0)).read("黍")["workCount"], 0)

    def test_missing_invalid_or_wrong_tag_cannot_become_zero(self):
        for count in [None, -1, 2.5, True, "2.9万"]:
            with self.subTest(count=count), self.assertRaises(CollectError):
                self.source(self.body(count)).read("黍")
        body = self.body(); body["data"]["tag_name"] = "鬼叔黍"
        with self.assertRaises(CollectError):
            self.source(body).read("黍")

    def test_risk_control_stops_instead_of_returning_empty_count(self):
        with self.assertRaises(CollectError) as caught:
            self.source({"code": -412}).read("黍")
        self.assertEqual(caught.exception.kind, "blocked")


class FakeSource:
    def __init__(self, failure=None):
        self.requests = 0
        self.tags = []
        self.failure = failure

    def read(self, tag):
        self.requests += 1; self.tags.append(tag)
        if tag == self.failure:
            raise CollectError("测试受限", "blocked")
        return {"platform": "bilibili", "kind": "tag_count", "tag": tag,
                "workCount": 0, "status": "completed", "annualCounts": None,
                "observedAt": "2026-11-03T00:00:00+00:00"}


class BilibiliCountStorageTests(unittest.TestCase):
    def test_website_export_keeps_zero_missing_provenance_and_operator_forms_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            roster = [{"id": "base", "name": "阿米娅"}, {"id": "medical", "name": "阿米娅(医疗)"}]
            atomic_json(root / "public/data/operators.json", roster)
            store = TagStatsStore(root / ".local", "bilibili")
            store.put("run", {"key": "阿米娅", "operatorIds": ["base"], "scope": "bare"},
                      {"tag": "阿米娅", "workCount": 0, "countBasis": "exact_tag_intersection",
                       "requiredTagGroups": [["阿米娅"], ["明日方舟"]],
                       "observedAt": "2026-11-03T00:00:00+00:00"})
            store.fail("run", "阿米娅(医疗)", "failed", "尚未取得")
            store.db.close()
            data = export_counts(root)
            self.assertEqual([r["workCount"] for r in data["records"]], [0, None])
            self.assertEqual(data["metadata"]["availableTags"], 1)
            self.assertEqual(data["records"][1]["missingReason"], "尚未取得")
            self.assertEqual(data["records"][0]["observedAt"], "2026-11-03T00:00:00+00:00")
            self.assertNotIn("year", data["records"][0])
            self.assertTrue((root / "public/data/bilibili-tag-counts.json").is_file())
            self.assertEqual(data, count_snapshot(root))

    def test_plan_contains_all_434_chinese_names_only(self):
        roster = json.loads((Path(__file__).resolve().parents[1] / "public/data/operators.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            collector = BilibiliCountCollector(roster, store=store, source=FakeSource(), runtime=Path(directory) / "runtime")
            self.assertEqual(len(collector.plan), 434)
            self.assertEqual({p["tag"] for p in collector.plan}, {o["name"] for o in roster})
            self.assertEqual((collector.workers, collector.job["interval"]), (1, 3.5))
            store.db.close()

    def test_resume_skips_committed_tags_and_monitor_reads_count_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); runtime = root / "bilibili"
            store = TagStatsStore(root, "bilibili"); source = FakeSource()
            collector = BilibiliCountCollector(OPS, store=store, source=source, runtime=runtime)
            item = collector.queue.get_nowait()
            store.put(collector.job["id"], item, source.read(item["tag"]))
            collector.publish()
            resumed_source = FakeSource()
            resumed = BilibiliCountCollector(OPS, store=store, source=resumed_source, runtime=runtime)
            self.assertEqual(resumed.job["id"], collector.job["id"])
            resumed.worker(); resumed.publish()
            self.assertEqual(resumed_source.tags, ["令"])
            self.assertEqual(snapshot(root, "bilibili")[0], 2)
            self.assertEqual(store.db.execute("SELECT count(*) FROM bilibili_tag_history").fetchone()[0], 2)
            store.db.close()

    def test_blocked_stops_rest_of_queue_without_writing_false_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = TagStatsStore(root, "bilibili")
            source = FakeSource("黍")
            collector = BilibiliCountCollector(OPS, store=store, source=source, runtime=root / "bilibili")
            collector.worker()
            self.assertEqual(source.tags, ["黍"])
            self.assertTrue(collector.halted.is_set())
            self.assertEqual(store.db.execute("SELECT count(*) FROM bilibili_tag_stats").fetchone()[0], 0)
            self.assertEqual(store.db.execute("SELECT state FROM bilibili_tag_queue").fetchone()[0], "blocked")
            store.db.close()

    def test_lofter_and_bilibili_tables_are_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); bili = TagStatsStore(root, "bilibili"); lofter = TagStatsStore(root)
            item = {"key": "黍", "operatorIds": ["shu"], "scope": "bare"}
            bili.put("run", item, FakeSource().read("黍"))
            self.assertEqual(lofter.done("run"), set())
            self.assertEqual(bili.done("run"), {"黍"})
            bili.db.close(); lofter.db.close()

    def test_purge_removes_only_legacy_bilibili_and_preserves_counts_and_others(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = Store(root)
            for platform in ["pixiv", "bilibili", "lofter"]:
                store.put({"platform": platform, "id": "one", "operatorIds": ["shu"]})
                store.query(platform, platform, "shu", "黍", "works", False)
                store.seen(platform, "one"); store.fault(platform, "one", "测试")
                store.queue_metric(platform, "one", "works")
                store.coverage({"platform": platform, "operatorId": "shu"})
            store.db.close()
            counts = TagStatsStore(root, "bilibili")
            counts.put("run", {"key": "黍", "operatorIds": ["shu"], "scope": "bare"}, FakeSource().read("黍"))
            counts.db.close(); path = root / "http-collection.sqlite"
            before = other_platform_fingerprint(path)
            report = purge_database(path)
            self.assertEqual(report["removedWorks"], 1)
            self.assertEqual(before, other_platform_fingerprint(path))
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM bilibili_tag_stats").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT query_key FROM seen ORDER BY query_key").fetchall(), [("lofter",), ("pixiv",)])
                self.assertEqual(db.execute("SELECT count(*) FROM works WHERE key GLOB 'bilibili:*'").fetchone()[0], 0)

    def test_snapshot_filter_preserves_other_platforms_and_original_input(self):
        old = {"works": [{"platform": "pixiv", "operatorIds": ["shu"]}, {"platform": "bilibili"}],
               "records": [{"platform": "bilibili"}], "coverage": [{"platform": "bilibili"}],
               "metadata": {"workCount": 2}}
        new, removed = clean_snapshot(old)
        self.assertEqual(removed, {"works": 1, "records": 1, "coverage": 1})
        self.assertEqual(new["metadata"]["workCount"], 1)
        self.assertEqual(len(old["works"]), 2)


if __name__ == "__main__":
    unittest.main()
