"""LOFTER 原生指标、分页、失败续采和增量边界验证。"""

from collections import deque
import copy
import tempfile
import threading
from pathlib import Path
import unittest

from collector_sources.base import Page
from collector_sources.lofter import Lofter
from lofter_runtime import LofterCollector, LofterStore
from tag_session import CollectError


T = 1793620000000
OP = {"id": "lofter-test-operator", "name": "蕾缪安"}


def row(native_id=1, timestamp=T, likes=0):
    return {
        "postData": {
            "postView": {
                "id": native_id, "title": "测试作品", "type": 2,
                "tagList": ["蕾缪安"], "publishTime": timestamp,
                "permalink": f"test_{native_id}",
            },
            "postCount": {"favoriteCount": likes, "viewCount": 0, "hotCount": 999},
        },
        "blogInfo": {"blogName": "example", "blogNickName": "不应保存的作者资料"},
    }


def page(*rows, offset=10, done=False):
    return Page(
        [{"id": str(r["postData"]["postView"]["id"]), "row": r} for r in rows],
        {"offset": offset, "anchor": "test_1"}, done,
    )


class FakeSource(Lofter):
    def __init__(self, *pages):
        self.pages = deque(pages)
        self.calls = []

    def page(self, tag, kind="works", cursor=None):
        self.calls.append(copy.deepcopy(cursor))
        value = self.pages.popleft()
        if isinstance(value, Exception):
            raise value
        return value


class LofterSourceTests(unittest.TestCase):
    def source(self, body):
        class Response:
            def json(self):
                return body

            def close(self):
                pass

        source = Lofter.__new__(Lofter)
        source.local = threading.local()
        source.local.ready = True
        source.post = lambda *a, **kw: Response()
        return source

    def test_preserves_exact_zero_likes_without_using_popularity_or_placeholder_views(self):
        source = Lofter.__new__(Lofter)
        work = source.row_work(page(row()).items[0])
        self.assertEqual(work["likes"], 0)
        self.assertIsNone(work["views"])
        self.assertEqual(work["nativeMetrics"]["viewCount"], 0)
        self.assertEqual(work["nativeMetrics"]["hotCount"], 999)
        self.assertNotIn("blogInfo", work)
        self.assertEqual(work["url"], "https://example.lofter.com/post/test_1")

    def test_abbreviated_likes_are_missing_not_zero(self):
        source = Lofter.__new__(Lofter)
        work = source.row_work(page(row(likes="1.2万")).items[0])
        self.assertIsNone(work["likes"])
        self.assertIn("likes", work["missing"])

    def test_partial_page_does_not_mean_end(self):
        source = self.source({"code": 0, "data": {"list": [row()], "offset": 1}})
        result = source.page("蕾缪安")
        self.assertFalse(result.done)
        self.assertEqual(result.cursor, {"offset": 1, "anchor": "test_1"})

    def test_null_payload_is_not_an_empty_tag(self):
        source = self.source({"code": 0, "data": None})
        with self.assertRaises(CollectError) as caught:
            source.page("蕾缪安")
        self.assertEqual(caught.exception.kind, "blocked")

    def test_nonadvancing_offset_is_restricted(self):
        source = self.source({"code": 0, "data": {"list": [row()], "offset": 10}})
        with self.assertRaises(CollectError) as caught:
            source.page("蕾缪安", cursor={"offset": 10, "anchor": "test_1"})
        self.assertEqual(caught.exception.kind, "restricted")

    def test_native_end_marker_keeps_works_on_last_page(self):
        source = self.source({"code": 0, "data": {"list": [row()], "offset": -1}})
        result = source.page("蕾缪安", cursor={"offset": 10, "anchor": "test_1"})
        self.assertTrue(result.done)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.cursor["offset"], 10)

    def test_native_end_marker_accepts_an_empty_tag(self):
        source = self.source({"code": 0, "data": {"list": [], "offset": -1}})
        self.assertTrue(source.page("明日方舟12F").done)

    def test_empty_page_without_end_marker_is_not_exhausted(self):
        source = self.source({"code": 0, "data": {"list": [], "offset": 20}})
        with self.assertRaises(CollectError) as caught:
            source.page("蕾缪安", cursor={"offset": 10, "anchor": "test_1"})
        self.assertEqual(caught.exception.kind, "restricted")

    def test_missing_native_tags_cannot_be_attributed_from_search(self):
        bad = row()
        del bad["postData"]["postView"]["tagList"]
        with self.assertRaises(CollectError):
            Lofter.__new__(Lofter).row_work(page(bad).items[0])


class LofterResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = LofterStore(self.root)

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def collector(self, source, mode="full", overlap=0):
        return LofterCollector(
            [OP], mode=mode, overlap_hours=overlap, store=self.store,
            runtime=self.root / "runtime", source=source,
        )

    def watermark(self, value=T):
        self.store.db.execute("INSERT INTO lofter_watermarks VALUES(?,?)", ("蕾缪安", value))
        self.store.db.commit()

    def test_full_scan_resumes_saved_native_offset(self):
        first = self.collector(FakeSource(page(row(), offset=10)))
        state = first.unit("蕾缪安")
        self.assertFalse(first.step(state))
        second_source = FakeSource(page(row(2, T-10), offset=20))
        second = self.collector(second_source)
        resumed = second.unit("蕾缪安")
        self.assertEqual(resumed["pages"], 1)
        second.step(resumed)
        self.assertEqual(second_source.calls, [{"offset": 10, "anchor": "test_1"}])
        self.assertEqual(self.store.work_count(), 2)

    def test_incremental_starts_at_latest_and_does_not_stop_at_first_known_work(self):
        self.watermark()
        source = FakeSource(
            page(row(1, T+10), offset=10),
            page(row(2, T+1), offset=20),
            page(row(3, T-10), offset=30),
        )
        old = source.row_work(page(row(1, T+10)).items[0])
        self.store.put({**old, "operatorIds": [OP["id"]]})
        collector = self.collector(source, "incremental")
        state = collector.unit("蕾缪安")
        self.assertFalse(collector.step(state))
        self.assertFalse(collector.step(state))
        self.assertTrue(collector.step(state))
        self.assertEqual(source.calls[0], None)
        self.assertEqual(self.store.work_count(), 3)
        self.assertEqual(self.store.watermark("蕾缪安"), state["upper_ms"])

    def test_failure_preserves_watermark_and_resume_cursor(self):
        self.watermark()
        source = FakeSource(page(row(1, T+10)), CollectError("网络失败"))
        collector = self.collector(source, "incremental")
        state = collector.unit("蕾缪安")
        collector.step(state)
        with self.assertRaises(CollectError):
            collector.step(state)
        self.assertEqual(self.store.watermark("蕾缪安"), T)
        resumed = self.collector(FakeSource(), "incremental").unit("蕾缪安")
        self.assertEqual(resumed["cursor"]["offset"], 10)
        self.assertEqual(resumed["upper_ms"], state["upper_ms"])

    def test_incremental_overlap_includes_equal_timestamp_boundary(self):
        self.watermark()
        source = FakeSource(page(row(1, T)), page(row(2, T-1), offset=20))
        collector = self.collector(source, "incremental")
        state = collector.unit("蕾缪安")
        self.assertFalse(collector.step(state))
        self.assertTrue(collector.step(state))

    def test_completed_full_scan_is_skipped_on_resume(self):
        collector = self.collector(FakeSource(page(done=True)))
        state = collector.unit("蕾缪安")
        collector.step(state)
        source = FakeSource()
        second = self.collector(source)
        self.assertTrue(second.step(second.unit("蕾缪安")))
        self.assertFalse(source.calls)

    def test_incremental_without_baseline_must_reach_end(self):
        collector = self.collector(FakeSource(page(row()), page(done=True)), "incremental")
        state = collector.unit("蕾缪安")
        self.assertEqual(state["cutoff_ms"], 0)
        self.assertFalse(collector.step(state))
        self.assertTrue(collector.step(state))

    def test_repeated_page_does_not_advance_cursor_or_success_boundary(self):
        same = page(row())
        collector = self.collector(FakeSource(same, same))
        state = collector.unit("蕾缪安")
        collector.step(state)
        with self.assertRaises(CollectError) as caught:
            collector.step(state)
        self.assertEqual(caught.exception.kind, "restricted")
        self.assertEqual(self.store.watermark("蕾缪安"), 0)
        self.assertEqual(self.store.checkpoint("蕾缪安", "full")["pages"], 1)

    def test_reordered_page_does_not_advance_success_boundary(self):
        collector = self.collector(FakeSource(page(row(1, T), row(2, T+1))))
        with self.assertRaises(CollectError):
            collector.step(collector.unit("蕾缪安"))
        self.assertEqual(self.store.work_count(), 0)
        self.assertEqual(self.store.watermark("蕾缪安"), 0)

    def test_half_written_page_is_replayed_and_deduplicated(self):
        original = self.store.put
        writes = []

        def interrupted(work):
            writes.append(work["id"])
            if len(writes) == 2:
                raise RuntimeError("模拟中断")
            original(work)

        collector = self.collector(FakeSource(page(row(1), row(2, T-1))))
        state = collector.unit("蕾缪安")
        self.store.put = interrupted
        with self.assertRaises(RuntimeError):
            collector.step(state)
        self.store.put = original
        self.assertEqual(self.store.work_count(), 1)
        self.assertIsNone(self.store.checkpoint("蕾缪安", "full"))
        second = self.collector(FakeSource(page(row(1), row(2, T-1))))
        second.step(second.unit("蕾缪安"))
        self.assertEqual(self.store.work_count(), 2)


if __name__ == "__main__":
    unittest.main()
