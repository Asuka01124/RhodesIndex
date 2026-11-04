import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from collector_sources.weibo_topics import WeiboTopics, parse_topic_counts
from lofter_tag_stats import TagStatsStore
from tag_session import CollectError
from weibo_collect import WeiboTopicCollector, make_weibo_plan
from xiaohongshu_collect import make_plan as make_xiaohongshu_plan


def page(tag, overview=""):
    return f"<h4>#{tag}#</h4><h4>热搜数据</h4>{overview}<h4>实时热度</h4>"


class WeiboTopicsTests(unittest.TestCase):
    def test_only_overview_counters_with_native_precision(self):
        document = page("明日方舟测试", """
            <h4>数据总览</h4><ul>
            <li><span>不相关字段</span></li>
            <li><span><strong>2.3</strong>万</span>阅读次数</li>
            <li><span><strong>12</strong></span>讨论次数</li>
            <li><span><strong>0</strong></span>原创人数</li></ul>
            <script>const template = '<li><span>999</span>原创人数</li>';</script>
        """)
        counts = parse_topic_counts(document, "明日方舟测试")
        self.assertEqual(counts["reads"]["display"], "2.3万")
        self.assertIsNone(counts["reads"]["value"])
        self.assertEqual(counts["reads"]["estimate"], 23000)
        self.assertEqual(counts["discussions"]["value"], 12)
        self.assertEqual(counts["originalAuthors"]["value"], 0)

    def test_missing_overview_is_distinguished_from_login_or_wrong_topic(self):
        counts = parse_topic_counts(page("未收录"), "未收录")
        self.assertTrue(all(value is None for value in counts.values()))
        for document in ["<title>微博登录</title>", page("别的话题"), page("目标", "<h4>数据总览</h4>")]:
            with self.assertRaises(CollectError) as caught:
                parse_topic_counts(document, "目标")
            self.assertEqual(caught.exception.kind, "blocked")

    def test_redirect_pauses_without_following_or_writing_counts(self):
        with patch("collector_sources.weibo_topics.Session") as session:
            response = session.return_value.request.return_value.__enter__.return_value
            response.status_code = 302
            with self.assertRaises(CollectError) as caught:
                WeiboTopics().read("明日方舟测试")
        self.assertEqual(caught.exception.kind, "blocked")
        self.assertFalse(session.return_value.request.call_args.kwargs["allow_redirects"])

    def test_plan_qualifies_common_names_and_merges_amiya_forms(self):
        operators = [
            {"id": "char_002_amiya", "name": "阿米娅"},
            {"id": "char_1037_amiya3", "name": "阿米娅(医疗)"},
            {"id": "alice", "name": "爱丽丝"},
            {"id": "shu", "name": "黍"},
            {"id": "w", "name": "W"},
        ]
        plan = make_weibo_plan(operators)
        self.assertEqual(plan, make_xiaohongshu_plan(operators))
        self.assertEqual([item["tag"] for item in plan], ["阿米娅", "黍", "明日方舟爱丽丝", "W"])
        self.assertEqual(len(plan[0]["operatorIds"]), 2)
        self.assertEqual(
            [item["scope"] for item in plan],
            ["bare_character_topic", "bare_character_topic", "arknights_prefixed_topic", "bare_character_topic"],
        )

    def test_resume_skips_committed_topic_and_export_marks_failed_as_null(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            operators = [{"id": "a", "name": "爱丽丝"}, {"id": "b", "name": "黍"}]
            plan = make_weibo_plan(operators)
            store = TagStatsStore(runtime, "weibo")
            try:
                source = Mock(requests=0)
                first = WeiboTopicCollector(operators, store=store, source=source, runtime=runtime, plan=plan)
                store.put(first.job["id"], plan[0], {
                    "tag": plan[0]["tag"], "nativeMetrics": {"originalAuthors": {"value": 2}}, "status": "ok",
                })
                store.fail(first.job["id"], plan[1]["key"], "failed", "网络失败")
                first.publish()
                snapshot = json.loads((runtime / "topic-counts.json").read_text(encoding="utf-8"))
                self.assertEqual(snapshot["records"][1]["status"], "failed")
                self.assertIsNone(snapshot["records"][1]["nativeMetrics"]["originalAuthors"])
                resumed = WeiboTopicCollector(operators, store=store, source=source, runtime=runtime, plan=plan)
                self.assertEqual(resumed.job["id"], first.job["id"])
                self.assertEqual(resumed.queue.get_nowait()["tag"], plan[1]["tag"])
                self.assertTrue(resumed.queue.empty())
            finally:
                store.db.close()
