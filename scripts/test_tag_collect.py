import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tag_collect import Collector
from tag_sources import Page, Bilibili, Tumblr, Pixiv
from tag_match import Matcher
from tag_session import exact_count, CollectError
from tag_store import Store

OP = {
    "id": "operator",
    "name": "蕾缪安",
    "englishName": "Lemuen",
    "japaneseName": "レミュアン",
}


def work(id="one", likes=3, views=None, tags=None):
    return dict(
        id=id,
        platform="pixiv",
        title="明日方舟",
        url="https://www.pixiv.net/artworks/" + id,
        publishedAt="2025-12-31T23:30:00Z",
        observedAt="2026-11-01T00:00:00Z",
        likes=likes,
        views=views,
        tags=["明日方舟", "蕾缪安"] if tags is None else list(tags),
        operatorIds=["operator"],
        matchBasis="exact_tag",
        nativeMetrics={},
    )


class NeedsDetail:
    """替身默认逐件取详情；检索行自带标签的平台（Pixiv）另行实现 row_work。"""

    deferred_metrics = False

    def row_work(self, item, kind):
        return None


class HttpCollectorTests(unittest.TestCase):
    def test_empty_intermediate_page_with_next_cursor_continues(self):
        class Fake(NeedsDetail):
            platform = "pixiv"

            def page(self, tag, kind, cursor):
                return (
                    Page([{"id": "one"}], None, True, 1)
                    if cursor
                    else Page([], 2, False, 1)
                )

            def detail(self, item, kind):
                return work()

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory)
            result = c.crawl_query(Fake(), OP, "蕾缪安", "artworks")
            self.assertEqual(result["state"], "exhausted")
            self.assertEqual(result["candidates"], 1)
            c.store.db.close()

    def test_bilibili_splits_a_capped_time_range(self):
        calls = []

        class Http:
            def json(self, method, url, params, headers):
                lo = params["pubtime_begin_s"]
                hi = params["pubtime_end_s"]
                calls.append((lo, hi))
                if lo == 1 and hi == 100:
                    return {
                        "code": 0,
                        "data": {"numResults": 1000, "numPages": 20, "result": []},
                    }
                return {
                    "code": 0,
                    "data": {
                        "numResults": 1,
                        "numPages": 1,
                        "result": [{"bvid": "BV" + str(lo), "pubdate": lo}],
                    },
                }

        source = Bilibili.__new__(Bilibili)
        source.session = Http()
        with patch("tag_sources.time.time", return_value=100):
            first = source.page("蕾缪安", "works", None)
            second = source.page("蕾缪安", "works", first.cursor)
        self.assertFalse(first.done)
        self.assertTrue(second.done)
        self.assertEqual(calls, [(1, 100), (1, 50), (51, 100)])

    def test_tumblr_likes_are_separate_from_total_notes(self):
        source = Tumblr.__new__(Tumblr)
        b = source.detail(
            {
                "id": "123",
                "post": {
                    "summary": "画作",
                    "post_url": "https://example.tumblr.com/post/123",
                    "timestamp": 1609459200,
                    "like_count": 7,
                    "note_count": 110,
                    "tags": ["arknights", "Lemuen"],
                },
            },
            "works",
        )
        self.assertEqual(b["likes"], 7)
        self.assertIsNone(b["views"])
        self.assertEqual(b["nativeMetrics"]["noteCount"], 110)

    def test_tumblr_reblog_ancestors_are_not_collected_as_works(self):
        body = [
            {
                "objectType": "post",
                "id": "999",
                "summary": "转发",
                "tags": ["arknights"],
                "trail": [
                    {
                        "post": {
                            "objectType": "post",
                            "id": "67643602390",
                            "summary": "原作",
                            "tags": ["gundam"],
                        }
                    }
                ],
            }
        ]
        ids = [node["id"] for node in Tumblr.timeline_posts(body)]
        self.assertEqual(ids, ["999"])

    def test_tumblr_detail_records_reblog_relation(self):
        source = Tumblr.__new__(Tumblr)
        reblog = source.detail(
            {
                "id": "999",
                "post": {
                    "summary": "转发",
                    "post_url": "https://example.tumblr.com/post/999",
                    "timestamp": 1609459200,
                    "like_count": 3,
                    "tags": ["arknights"],
                    "trail": [{"post": {"id": "111"}}],
                },
            },
            "works",
        )
        self.assertEqual(reblog["rootId"], "111")
        self.assertTrue(reblog["isReblog"])
        original = source.detail(
            {
                "id": "111",
                "post": {
                    "summary": "原作",
                    "post_url": "https://example.tumblr.com/post/111",
                    "timestamp": 1609459200,
                    "like_count": 50,
                    "tags": ["arknights"],
                    "trail": [],
                },
            },
            "works",
        )
        self.assertIsNone(original["rootId"])
        self.assertFalse(original["isReblog"])
        # 转发的点赞数只算自己这一条，不累计转发链上的互动。
        self.assertEqual(reblog["likes"], 3)
        self.assertEqual(original["likes"], 50)

    def fixture(self, path, resume=False):
        c = Collector.__new__(Collector)
        c.store = Store(Path(path))
        c.matcher = Matcher([OP])
        c.resume = resume
        c.stopped = threading.Event()
        c.lock = threading.RLock()
        c.active = {}
        c.errors = []
        c.job = {}
        c.stopping = lambda: False
        return c

    def test_full_pagination_has_no_48_or_240_limit(self):
        class Fake(NeedsDetail):
            platform = "pixiv"
            calls = []

            def page(self, tag, kind, cursor):
                p = cursor or 1
                self.calls.append(p)
                return Page(
                    (
                        [{"id": str(i)} for i in range((p - 1) * 130, p * 130)]
                        if p < 4
                        else []
                    ),
                    p + 1,
                    p == 4,
                    390,
                )

            def detail(self, item, kind):
                return work(item["id"])

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory)
            source = Fake()
            r = c.crawl_query(source, OP, "蕾缪安", "artworks")
            self.assertEqual(r["state"], "exhausted")
            self.assertEqual(len(c.store.snapshot()["works"]), 390)
            self.assertEqual(source.calls, [1, 2, 3, 4])
            c.store.db.close()

    def test_repeat_page_is_restricted_not_complete(self):
        class Fake(NeedsDetail):
            platform = "pixiv"

            def page(self, tag, kind, cursor):
                return Page([{"id": "one"}], (cursor or 1) + 1, False, 500)

            def detail(self, item, kind):
                return work()

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory)
            r = c.crawl_query(Fake(), OP, "蕾缪安", "artworks")
            self.assertEqual(r["state"], "restricted")
            c.store.db.close()

    def test_advertised_total_is_not_silently_truncated(self):
        class Fake(NeedsDetail):
            platform = "pixiv"

            def page(self, tag, kind, cursor):
                return Page([{"id": "one"}], None, True, 1000)

            def detail(self, item, kind):
                return work()

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory)
            r = c.crawl_query(Fake(), OP, "蕾缪安", "artworks")
            self.assertEqual(r["state"], "restricted")
            c.store.db.close()

    def test_resume_replays_saved_items_then_advances(self):
        class Fake(NeedsDetail):
            platform = "pixiv"

            def page(self, tag, kind, cursor):
                return Page(
                    [{"id": "one"}] if not cursor else [{"id": "two"}],
                    2 if not cursor else 3,
                    bool(cursor),
                    2,
                )

            def detail(self, item, kind):
                return work(item["id"])

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, True)
            key = json.dumps(
                ["pixiv", "operator", "蕾缪安", "artworks"],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            c.store.query(key, "pixiv", "operator", "蕾缪安", "artworks", False)
            c.store.seen(key, "one")
            c.store.put(work())
            r = c.crawl_query(Fake(), OP, "蕾缪安", "artworks")
            self.assertEqual(r["state"], "exhausted")
            self.assertEqual(len(c.store.snapshot()["works"]), 2)
            c.store.db.close()

    def test_dedup_null_metrics_and_beijing_year(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            store.put(work())
            store.put(work(likes=5))
            store.put(work("two", 0, None))
            data = store.snapshot()
            self.assertEqual(len(data["works"]), 2)
            r = data["records"][0]
            self.assertEqual(r["year"], 2026)
            self.assertEqual(r["likes"], 5)
            self.assertIsNone(r["views"])
            self.assertEqual(r["metricCoverage"], {"likes": 2, "views": 0})
            store.db.close()

    def test_role_tag_is_exact_and_short_counts_remain_null(self):
        matcher = Matcher([OP])
        self.assertTrue(matcher.evaluate(["蕾缪安"], OP).accepted)
        self.assertTrue(matcher.evaluate(["明日方舟蕾缪安"], OP).accepted)
        self.assertTrue(matcher.evaluate(["レミュアン"], OP).accepted)
        self.assertFalse(matcher.evaluate(["明日方舟", "蕾缪安姐姐"], OP).accepted)
        self.assertEqual(exact_count("305"), 305)
        self.assertIsNone(exact_count("1.2万"))
        self.assertIsNone(exact_count(True))


class RoundRobinTests(unittest.TestCase):
    """公平轮转：一个单元取一页就排到队尾，大标签不优先吃干抹净。"""

    def fixture(self, path, operators, workers=1):
        c = Collector.__new__(Collector)
        c.store = Store(Path(path))
        c.matcher = Matcher(operators)
        c.operators = operators
        c.workers = workers
        c.resume = False
        c.stopped = threading.Event()
        c.lock = threading.RLock()
        c.active = {}
        c.errors = []
        c.inflight = 0
        c.job = {"completed": 0, "completedKeys": [], "total": 0}
        c.stopping = lambda: c.stopped.is_set()
        return c

    @staticmethod
    def roster(*names):
        return [
            dict(OP, id="op" + str(i), name=name, japaneseName=None, englishName=None)
            for i, name in enumerate(names)
        ]

    def source(self, collector, limit=None, blocked=(), single=True):
        class Fake(NeedsDetail):
            platform = "pixiv"
            kinds = ("artworks",)

            def __init__(self):
                self.order = []

            def page(self, tag, kind, cursor):
                self.order.append(tag)
                if tag in blocked:
                    raise CollectError("接口拒绝读取。", "blocked")
                n = len(self.order)
                if limit and n >= limit:
                    collector.stopped.set()
                row = {"id": f"{tag}-{n}", "tag": tag}
                if single:
                    return Page([row], None, True, None)
                return Page([row], n + 1, False, None)

            def detail(self, item, kind):
                return work(item["id"], tags=[item["tag"]])

        return Fake()

    def test_no_unit_gets_a_second_page_before_every_unit_has_had_one(self):
        ops = self.roster("蕾缪零", "蕾缪一", "蕾缪二")
        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, ops)
            source = self.source(c, limit=18, single=False)
            c.run_units("pixiv", source, c.units(source))
            first, second = source.order[:9], source.order[9:]
            self.assertEqual(len(set(first)), 9)
            self.assertEqual(second, first)
            c.store.db.close()

    def test_a_blocked_tag_does_not_stop_the_other_operators(self):
        ops = self.roster("蕾缪安", "能天使")
        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, ops)
            source = self.source(c, blocked=("蕾缪安",))
            units = c.units(source)
            c.run_units("pixiv", source, units)
            c.record_coverage("pixiv", units)
            snapshot = c.store.snapshot()
            rows = {r["operatorId"]: r for r in snapshot["coverage"]}
            self.assertEqual(rows["op0"]["status"], "blocked")
            self.assertEqual(rows["op1"]["status"], "exhausted")
            self.assertEqual(rows["op1"]["matched"], 3)
            self.assertTrue(
                any(w["operatorIds"] == ["op1"] for w in snapshot["works"])
            )
            c.store.db.close()

    def test_untouched_operators_are_reported_pending_not_covered(self):
        ops = self.roster("蕾缪安", "能天使")
        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, ops)
            c.stopping = lambda: True
            source = self.source(c)
            units = c.units(source)
            c.run_units("pixiv", source, units)
            c.record_coverage("pixiv", units)
            rows = c.store.snapshot()["coverage"]
            self.assertEqual(source.order, [])
            self.assertEqual({r["operatorId"] for r in rows}, {"op0", "op1"})
            self.assertEqual({r["status"] for r in rows}, {"pending"})
            self.assertEqual(c.job["completedKeys"], [])
            c.store.db.close()

    def test_one_detail_request_attributes_every_matched_operator(self):
        class Once(NeedsDetail):
            calls = 0

            def detail(self, item, kind):
                self.calls += 1
                return work(item["id"], tags=["蕾缪安", "能天使"])

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, self.roster("蕾缪安", "能天使"))
            unit = c.new_unit("pixiv", c.operators[0], "蕾缪安", "artworks")
            c.load_checkpoint(None, unit)
            source = Once()
            self.assertFalse(c.observe(source, unit, {"id": "x"}))
            self.assertEqual(source.calls, 1)
            stored = c.store.get("pixiv", "x")
            self.assertEqual(stored["operatorIds"], ["op0", "op1"])
            self.assertEqual(sorted(stored["matchedTags"]), ["能天使", "蕾缪安"])
            self.assertEqual(c.store.matched("pixiv", "op1"), 1)
            c.store.db.close()


    def test_a_dead_adapter_still_records_coverage_for_every_operator(self):
        def broken(interval):
            raise CollectError("平台接口拒绝读取。", "blocked")

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, self.roster("蕾缪安", "能天使"))
            c.interval = 0.7
            with patch("tag_collect.SOURCES", {"pixiv": broken}):
                c.crawl_platform("pixiv")
            rows = c.store.snapshot()["coverage"]
            self.assertEqual(len(rows), 2)
            self.assertEqual({r["status"] for r in rows}, {"blocked"})
            self.assertTrue(all("一个标签查询都没开始" in r["note"] for r in rows))
            c.store.db.close()


    def test_match_scope_is_recorded_per_operator(self):
        class Once(NeedsDetail):
            def detail(self, item, kind):
                return work(item["id"], tags=["空", "能天使(明日方舟)"])

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, self.roster("空", "能天使"))
            unit = c.new_unit("pixiv", c.operators[0], "空", "artworks")
            c.load_checkpoint(None, unit)
            c.observe(Once(), unit, {"id": "x"})
            stored = c.store.get("pixiv", "x")
            self.assertEqual(
                stored["matchScopes"], {"op0": "bare", "op1": "qualified"}
            )
            records = {r["operatorId"]: r for r in c.store.snapshot()["records"]}
            self.assertEqual(
                records["op0"]["scopes"],
                {"qualified": 0, "bare": 1, "unknown": 0},
            )
            self.assertEqual(
                records["op1"]["scopes"],
                {"qualified": 1, "bare": 0, "unknown": 0},
            )
            c.store.db.close()

    def test_a_later_qualified_hit_upgrades_a_bare_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, self.roster("空"))
            bare = work("x", tags=["空"])
            bare.update(operatorIds=["op0"], matchScopes={"op0": "bare"})
            c.store.put(bare)
            later = work("x", tags=["空(明日方舟)"])
            later.update(operatorIds=["op0"], matchScopes={"op0": "qualified"})
            c.store.put(later)
            self.assertEqual(
                c.store.get("pixiv", "x")["matchScopes"], {"op0": "qualified"}
            )
            c.store.db.close()


class PixivThrottleTests(unittest.TestCase):
    """限流时 pixiv 回 200 加空列表，绝不能被当成"这个标签没有作品"。

    反过来也一样要紧：真的没作品的标签绝不能被当成限流，
    否则每个空标签都要重试三轮、冻结全部线程 85 秒。
    """

    EMPTY_SECTION = {"data": [], "total": 0, "lastPage": 1}
    CONTROL_ROW = {"id": "1", "title": "t", "tags": ["アークナイツ"]}

    def session(self, control_rows, tag_section=None):
        class Fake:
            def __init__(self):
                self.calls = []
                self.penalties = []

            def json(self, method, url, params=None, headers=None):
                self.calls.append(params.get("word"))
                if params.get("word") == Pixiv.control_tag:
                    section = {"data": list(control_rows), "total": len(control_rows), "lastPage": 1}
                else:
                    section = dict(tag_section or PixivThrottleTests.EMPTY_SECTION)
                return {
                    "error": False,
                    "body": {
                        "illustManga": section,
                        "relatedTags": [{"tag": "明日方舟"}] * 20,
                        "tagTranslation": {"a": {}},
                    },
                }

            def penalty(self, seconds):
                self.penalties.append(seconds)

        source = Pixiv.__new__(Pixiv)
        source.session = Fake()
        return source

    def test_related_tags_are_not_evidence_of_throttling(self):
        # 实测：仇白／Vigil／チューバイ 都是 0 作品，却照样返回 20 条相关标签。
        # 相关标签来自标签图谱，不是检索结果，不能拿来分辨限流。
        source = self.session([self.CONTROL_ROW])
        section = source.search("仇白", "artworks", 1)
        self.assertEqual(section["data"], [])
        self.assertEqual(source.session.penalties, [])
        self.assertEqual(source.session.calls, ["仇白", Pixiv.control_tag])

    def test_an_empty_control_means_the_session_is_throttled(self):
        source = self.session([])
        with self.assertRaises(CollectError) as caught:
            source.search("凯尔希", "artworks", 1)
        self.assertEqual(caught.exception.kind, "blocked")
        self.assertEqual(source.session.penalties, [5.0, 20.0, 60.0])
        self.assertEqual(source.session.calls.count("凯尔希"), 4)
        self.assertEqual(source.session.calls.count(Pixiv.control_tag), 4)

    def test_a_failing_control_is_treated_as_throttled_not_as_empty(self):
        class Broken:
            def __init__(self):
                self.penalties = []

            def json(self, method, url, params=None, headers=None):
                if params.get("word") == Pixiv.control_tag:
                    raise CollectError("HTTP 429：限流。", "blocked")
                return {
                    "error": False,
                    "body": {"illustManga": dict(PixivThrottleTests.EMPTY_SECTION)},
                }

            def penalty(self, seconds):
                self.penalties.append(seconds)

        source = Pixiv.__new__(Pixiv)
        source.session = Broken()
        with self.assertRaises(CollectError) as caught:
            source.search("凯尔希", "artworks", 1)
        self.assertEqual(caught.exception.kind, "blocked")
        self.assertEqual(source.session.penalties, [5.0, 20.0, 60.0])

    def test_empty_time_window_is_never_suspicious(self):
        self.assertFalse(Pixiv.suspicious_empty(dict(self.EMPTY_SECTION), 1, True))
        self.assertFalse(Pixiv.suspicious_empty(dict(self.EMPTY_SECTION), 2, False))

    def test_running_past_the_last_page_is_a_normal_end(self):
        section = {"data": [], "total": 6751, "lastPage": 113}
        self.assertFalse(Pixiv.suspicious_empty(section, 113, False))
        self.assertFalse(Pixiv.suspicious_empty(section, 114, False))
        self.assertTrue(Pixiv.suspicious_empty(section, 50, False))


class PixivRowTests(unittest.TestCase):
    """检索行自带完整原生标签，归属不该再花一个详情请求。"""

    ROW = {
        "id": "64938272",
        "title": "CHEN",
        "illustType": 0,
        "xRestrict": 0,
        "url": "https://i.pximg.net/c/250x250_80_a2/img-master/x_p0_square1200.jpg",
        "tags": ["明日方舟", "Arknights", "Chen", "チェン(アークナイツ)"],
        "createDate": "2017-09-13T17:05:43+09:00",
        "pageCount": 1,
        "aiType": 0,
    }
    NOVEL = {
        "id": "11368761",
        "title": "阿米娅的小提琴独奏指导",
        "xRestrict": 1,
        "tags": ["R-18", "アークナイツ", "阿米娅", "明日方舟"],
        "createDate": "2019-07-07T21:24:48+09:00",
        "bookmarkCount": 6597,
        "wordCount": 4621,
    }

    def bare(self):
        source = Pixiv.__new__(Pixiv)
        # 不设 session：一旦 row_work 偷偷发请求就当场炸出来。
        return source

    def test_artwork_row_carries_tags_type_and_rating_without_a_request(self):
        got = self.bare().row_work({"id": "64938272", "row": dict(self.ROW)}, "artworks")
        self.assertEqual(got["id"], "64938272")
        self.assertEqual(got["url"], "https://www.pixiv.net/artworks/64938272")
        self.assertEqual(got["tags"], self.ROW["tags"])
        self.assertEqual(got["type"], "插画")
        self.assertEqual(got["rating"], "全年龄")
        self.assertEqual(got["publishedAt"], "2017-09-13T17:05:43+09:00")

    def test_missing_metrics_stay_missing_with_a_reason_not_zero(self):
        got = self.bare().row_work({"id": "64938272", "row": dict(self.ROW)}, "artworks")
        self.assertIsNone(got["likes"])
        self.assertIsNone(got["views"])
        self.assertIn("详情接口", got["missing"]["likes"])
        self.assertIn("详情接口", got["missing"]["views"])

    def test_novel_row_is_prefixed_and_keeps_native_counts(self):
        got = self.bare().row_work({"id": "11368761", "row": dict(self.NOVEL)}, "novels")
        self.assertEqual(got["id"], "novel:11368761")
        self.assertEqual(got["url"], "https://www.pixiv.net/novel/show.php?id=11368761")
        self.assertEqual(got["type"], "小说")
        self.assertEqual(got["rating"], "R-18")
        self.assertEqual(got["nativeMetrics"]["bookmarkCount"], 6597)

    def test_page_size_differs_per_kind(self):
        source = self.bare()
        self.assertEqual(source.page_size("artworks"), 60)
        self.assertEqual(source.page_size("novels"), 30)

    def test_page_cap_that_cannot_hold_the_total_is_clamped(self):
        source = self.bare()
        # 登录后插画仍停在 1000 页：41 万件只给到 6 万件，必须转时间窗二分。
        self.assertTrue(source.clamped(413206, 1000, "artworks"))
        # 小说 637 页 × 30 件正好等于总量，可以直接翻页。
        self.assertFalse(source.clamped(19110, 637, "novels"))
        self.assertFalse(source.clamped(0, 1, "artworks"))


class MetricsStageTests(unittest.TestCase):
    """点赞与播放只能逐件取；缺的留在队列里，补到的不能被重放冲掉。"""

    def fixture(self, path, operators):
        c = Collector.__new__(Collector)
        c.store = Store(Path(path))
        c.matcher = Matcher(operators)
        c.operators = operators
        c.workers = 1
        c.interval = 0.2
        c.resume = False
        c.stopped = threading.Event()
        c.lock = threading.RLock()
        c.active = {}
        c.errors = []
        c.inflight = 0
        c.job = {"completed": 0, "completedKeys": [], "total": 0}
        c.stopping = lambda: c.stopped.is_set()
        return c

    def test_a_queued_work_leaves_the_queue_once_likes_arrive(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            store.put(work("a", likes=None))
            store.queue_metric("pixiv", "a", "artworks")
            self.assertEqual([r["id"] for r in store.pending_metrics("pixiv")], ["a"])
            self.assertEqual(store.metrics_remaining("pixiv"), 1)
            store.put(work("a", likes=7))
            self.assertEqual(store.pending_metrics("pixiv"), [])
            store.db.close()

    def test_a_source_without_deferred_metrics_is_not_queued(self):
        """本来就拿不到点赞的平台不该进队列，否则永远补不完还算成缺失。"""

        class NoLikes(NeedsDetail):
            platform = "pixiv"
            kinds = ("artworks",)

            def page(self, tag, kind, cursor):
                return Page([{"id": "n1"}], None, True, None)

            def detail(self, item, kind):
                return work("n1", likes=None, views=None)

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, RoundRobinTests.roster("蕾缪安"))
            unit = c.new_unit("pixiv", c.operators[0], "蕾缪安", "artworks")
            c.load_checkpoint(None, unit)
            c.run_units("pixiv", NoLikes(), [unit])
            stored = c.store.get("pixiv", "n1")
            self.assertIsNone(stored["likes"])
            self.assertEqual(stored["operatorIds"], ["op0"])
            self.assertEqual(c.store.pending_metrics("pixiv"), [])
            c.store.db.close()

    def test_a_deferred_source_queues_the_work_for_the_metrics_stage(self):
        class Deferred(NeedsDetail):
            platform = "pixiv"
            kinds = ("artworks",)
            deferred_metrics = True

            def page(self, tag, kind, cursor):
                return Page([{"id": f"{tag}-1"}], None, True, None)

            def row_work(self, item, kind):
                return work(item["id"], likes=None, views=None)

            def detail(self, item, kind):
                raise AssertionError("翻页阶段不该请求详情")

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, RoundRobinTests.roster("蕾缪安"))
            unit = c.new_unit("pixiv", c.operators[0], "蕾缪安", "artworks")
            c.load_checkpoint(None, unit)
            c.run_units("pixiv", Deferred(), [unit])
            self.assertEqual(
                c.store.pending_metrics("pixiv"),
                [{"id": "蕾缪安-1", "kind": "artworks"}],
            )
            self.assertEqual(c.store.get("pixiv", "蕾缪安-1")["operatorIds"], ["op0"])
            c.store.db.close()

    def test_replaying_a_row_does_not_erase_observed_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            store.put(work("a", likes=4828, views=64742))
            replay = work("a", likes=None, views=None)
            replay["missing"] = {"likes": "留待指标阶段补齐。"}
            store.put(replay)
            stored = store.get("pixiv", "a")
            self.assertEqual(stored["likes"], 4828)
            self.assertEqual(stored["views"], 64742)
            self.assertNotIn("likes", stored["missing"])
            store.db.close()

    def test_a_real_zero_is_not_rescued_as_if_it_were_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory))
            store.put(work("a", likes=0, views=0))
            store.put(work("a", likes=None, views=None))
            stored = store.get("pixiv", "a")
            self.assertEqual(stored["likes"], 0)
            self.assertEqual(stored["views"], 0)
            store.db.close()

    def test_metrics_stage_fills_likes_and_dequeues(self):
        calls = []

        class Detail:
            """照 Pixiv.detail 的样子把小说 id 前缀补回去。"""

            def __init__(self, interval):
                pass

            def detail(self, item, kind):
                calls.append((item["id"], kind))
                prefix = "novel:" if kind == "novels" else ""
                return work(prefix + item["id"], likes=4828, views=64742)

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, RoundRobinTests.roster("蕾缪安"))
            c.store.put(work("64938272", likes=None))
            c.store.queue_metric("pixiv", "64938272", "artworks")
            c.store.put(work("novel:11368761", likes=None))
            c.store.queue_metric("pixiv", "novel:11368761", "novels")
            with patch("tag_collect.SOURCES", {"pixiv": Detail}):
                c.fill_metrics("pixiv")
            self.assertEqual(c.store.metrics_remaining("pixiv"), 0)
            self.assertEqual(c.store.get("pixiv", "64938272")["likes"], 4828)
            self.assertEqual(c.store.get("pixiv", "novel:11368761")["views"], 64742)
            self.assertEqual(
                sorted(calls), [("11368761", "novels"), ("64938272", "artworks")]
            )
            self.assertEqual(c.errors, [])
            c.store.db.close()

    def test_a_blocked_detail_keeps_the_work_queued_and_reports_it(self):
        class Blocked:
            def __init__(self, interval):
                pass

            def detail(self, item, kind):
                raise CollectError("HTTP 429：限流。", "blocked")

        with tempfile.TemporaryDirectory() as directory:
            c = self.fixture(directory, RoundRobinTests.roster("蕾缪安"))
            for id in ("a", "b"):
                c.store.put(work(id, likes=None))
                c.store.queue_metric("pixiv", id, "artworks")
            with patch("tag_collect.SOURCES", {"pixiv": Blocked}):
                c.fill_metrics("pixiv")
            self.assertEqual(c.store.metrics_remaining("pixiv"), 2)
            self.assertIsNone(c.store.get("pixiv", "a")["likes"])
            self.assertTrue(any("没有写成 0" in e for e in c.errors), c.errors)
            c.store.db.close()


class PixivWindowTests(unittest.TestCase):
    """登录会话仍有页数上限：装不下总量的标签必须转时间窗二分。"""

    @staticmethod
    def row(day):
        return {
            "id": "1",
            "title": "t",
            "tags": ["空"],
            "createDate": day + "T00:00:00+09:00",
            "illustType": 0,
            "xRestrict": 0,
        }

    def source(self, probe, windowed):
        class Fake:
            def __init__(self):
                self.calls = []

            def json(self, method, url, params=None, headers=None):
                self.calls.append((params.get("scd"), params.get("ecd"), params["p"]))
                total, last, day = (windowed if params.get("scd") else probe)
                section = {
                    "data": [PixivWindowTests.row(day)],
                    "total": total,
                    "lastPage": last,
                }
                return {
                    "error": False,
                    "body": {
                        "illustManga": section,
                        "novel": dict(section),
                        "relatedTags": [],
                        "tagTranslation": {},
                    },
                }

        source = Pixiv.__new__(Pixiv)
        source.session = Fake()
        return source

    def test_a_page_cap_below_the_total_switches_to_time_windows(self):
        # 实测：アークナイツ 共 413206 件，lastPage 却停在 1000（六万件）。
        source = self.source((413206, 1000, "2020-01-01"), (50, 2, "2020-01-01"))
        page = source.open("アークナイツ", "artworks")
        self.assertEqual(page.cursor["mode"], "windows")
        self.assertFalse(page.done)

    def test_a_last_page_that_holds_the_total_pages_directly(self):
        # 实测：小说 19110 件、637 页 × 30 件正好装下，不必二分。
        source = self.source((19110, 637, "2020-01-01"), (50, 2, "2020-01-01"))
        page = source.open("アークナイツ", "novels")
        self.assertEqual(page.cursor["mode"], "pages")
        self.assertEqual(page.cursor["page"], 2)

    def test_a_single_day_still_over_the_cap_is_reported_restricted(self):
        source = self.source((5000, 10, "2024-05-01"), (5000, 10, "2024-05-01"))
        page = source.page_windows(
            "空",
            "artworks",
            {
                "mode": "windows",
                "windows": [["2024-05-01", "2024-05-01"]],
                "page": 1,
                "got": 0,
                "restricted": False,
            },
        )
        self.assertTrue(page.restricted)
        self.assertTrue(page.cursor["restricted"])


if __name__ == "__main__":
    unittest.main()
