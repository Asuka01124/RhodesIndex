import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bilibili_tag_rules import matches_tags, rules_for
from collector_sources.bilibili_intersections import BilibiliIntersections
from lofter_tag_stats import TagStatsStore
from lofter_tag_export import export_counts
from tag_session import CollectError
from tag_store import atomic_json


OP = {"id": "alice", "name": "爱丽丝"}


def video(bvid="BV1one", tags="爱丽丝,明日方舟", date=10):
    return {"bvid": bvid, "tag": tags, "pubdate": date, "title": "<em>爱丽丝</em>"}


def page(rows, total=None, pages=1):
    return {"code": 0, "data": {"result": rows, "numResults": len(rows) if total is None else total, "numPages": pages}}


class IntersectionTests(unittest.TestCase):
    def test_exact_tags_exclude_common_name_and_title_only_hits(self):
        rules = rules_for(OP)
        self.assertTrue(matches_tags(["爱丽丝", "明日方舟"], rules))
        for tags in [["机甲爱丽丝", "明日方舟"], ["爱丽丝"], ["明日方舟", "阿米娅"]]:
            self.assertFalse(matches_tags(tags, rules))
        self.assertTrue(matches_tags(["阿米娅（医疗）", "明日方舟"], rules_for({"id": "medical", "name": "阿米娅(医疗)"})))

    def test_collaboration_requires_game_and_original_work(self):
        rules = rules_for({"id": "char_456_ash", "name": "灰烬"})
        self.assertFalse(matches_tags(["灰烬", "明日方舟"], rules))
        self.assertFalse(matches_tags(["灰烬", "彩虹六号"], rules))
        self.assertTrue(matches_tags(["灰烬", "明日方舟", "彩虹六号"], rules))

    def source(self, store, responses):
        with patch("collector_sources.bilibili_intersections.Session"):
            source = BilibiliIntersections([OP])
        source.bind(store, "run")
        source.session.json.side_effect = responses
        return source

    def test_pages_deduplicate_and_count_only_verified_intersection(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video(), video("BV2wrong", "明日方舟,机甲爱丽丝")], 3, 2),
                                         page([video(), video("BV3two")], 3, 2)])
            result = source.read("爱丽丝")
            self.assertEqual(result["workCount"], 2)
            self.assertEqual(result["rejectedRows"], 1)
            self.assertTrue(result["complete"])
            self.assertEqual(source.requests, 2)
            rows = store.db.execute("SELECT data FROM bilibili_intersection_matches").fetchall()
            self.assertTrue(all(json.loads(r[0])["publishedAt"] for r in rows))
            store.db.close()

    def test_capped_search_splits_time_window_instead_of_using_1000(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video()], 1000, 20), page([], 0, 0), page([video()])])
            result = source.read("爱丽丝")
            self.assertEqual(result["workCount"], 1)
            self.assertEqual(source.requests, 3)
            params = [c.kwargs["params"] for c in source.session.json.call_args_list]
            self.assertGreater(params[1]["pubtime_begin_s"], params[2]["pubtime_end_s"])
            store.db.close()

    def test_repeated_page_is_partial_and_not_double_counted(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video()], 3, 3), page([video()], 3, 3)])
            result = source.read("爱丽丝")
            self.assertEqual(result["workCount"], 1)
            self.assertFalse(result["complete"])
            self.assertTrue(result["truncated"])
            store.db.close()

    def test_early_end_and_missing_tags_never_claim_complete_or_fake_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video()], 10, 1)])
            self.assertFalse(source.read("爱丽丝")["complete"])
            source = self.source(store, [page([video(tags=None)])])
            source.bind(store, "other-run")
            result = source.read("爱丽丝")
            self.assertIsNone(result["workCount"])
            self.assertFalse(result["complete"])
            store.db.close()

    def test_equivalent_collaboration_queries_are_all_read_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            operator = {"id": "char_456_ash", "name": "灰烬"}
            with patch("collector_sources.bilibili_intersections.Session"):
                source = BilibiliIntersections([operator])
            source.bind(store, "run")
            source.session.json.side_effect = [
                page([video(tags="灰烬,明日方舟,彩虹六号")]),
                page([video(tags="灰烬,明日方舟,彩虹六号：围攻"),
                      video("BV2two", tags="灰烬,明日方舟,彩虹六号：围攻")]),
            ]
            self.assertEqual(source.read("灰烬")["workCount"], 2)
            self.assertEqual(source.requests, 2)
            store.db.close()

    def test_blocked_resume_keeps_page_checkpoint_and_verified_count(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video()], 2, 2), {"code": -412}])
            with self.assertRaises(CollectError) as caught:
                source.read("爱丽丝")
            self.assertEqual(caught.exception.kind, "blocked")
            source = self.source(store, [page([video(), video("BV2two")], 2, 2)])
            self.assertEqual(source.read("爱丽丝")["workCount"], 2)
            self.assertEqual(source.session.json.call_args.kwargs["params"]["page"], 2)
            store.db.close()

    def test_ignored_time_filter_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = self.source(store, [page([video(date=30)])])
            from bilibili_tag_rules import rules_for
            import hashlib
            digest = hashlib.sha256(json.dumps(rules_for(OP), ensure_ascii=False).encode()).hexdigest()
            source.save("爱丽丝", {"rulesHash": digest, "windows": [[1, 20]], "page": 1}, [])
            with self.assertRaisesRegex(CollectError, "时间"):
                source.read("爱丽丝")
            self.assertEqual(store.db.execute("SELECT COUNT(*) FROM bilibili_intersection_matches").fetchone()[0], 0)
            store.db.close()

    def test_lofter_export_preserves_rounded_display_zero_and_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_json(root / "public/data/operators.json", [OP, {"id": "missing", "name": "令"}])
            store = TagStatsStore(root / ".local")
            store.put("run", {"key": "爱丽丝", "operatorIds": ["alice"], "scope": "bare"}, {
                "tag": "爱丽丝", "status": "ok", "observedAt": "2026-11-03T00:00:00Z",
                "url": "https://www.lofter.com/tag/alice/new",
                "views": {"display": "1.2万", "exact": False, "value": None, "estimate": 12000, "atLeast": None},
                "participation": {"display": "0", "exact": True, "value": 0, "estimate": None, "atLeast": None}})
            store.fail("run", "令", "failed", "无法读取")
            data = export_counts(root)
            self.assertEqual(data["metadata"]["availableTags"], 1)
            self.assertIsNone(data["records"][0]["views"]["value"])
            self.assertEqual(data["records"][0]["views"]["display"], "1.2万")
            self.assertEqual(data["records"][0]["participation"]["value"], 0)
            self.assertIsNone(data["records"][1]["participation"])
            store.db.close()
