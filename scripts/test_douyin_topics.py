"""验证原生话题计数、精确匹配与接口受限，不包含凭据。"""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from collector_sources.douyin_topics import DouyinTopics, ENDPOINT, parse_topics
from tag_session import CollectError
import douyin_collect


def payload(rows):
    return {"status_code": 0, "sug_list": rows}


def row(name="黍", cid="123", count=12):
    return {"cha_name": name, "cid": cid, "view_count": count}


class TopicTests(unittest.TestCase):
    def test_exact_name_excludes_substrings_and_does_not_sum_related_topics(self):
        result = parse_topics(payload([row("鬼叔黍", "1", 999), row("黍", "2", 12), row("黍cos", "3", 34)]), "黍")
        self.assertEqual(result["playCount"], 12)
        self.assertEqual(result["topicId"], "2")
        self.assertEqual(len(result["returnedTopics"]), 3)
        self.assertIn("unverified", result["association"])

    def test_zero_is_valid_but_missing_is_null(self):
        self.assertEqual(parse_topics(payload([row(count=0)]), "黍")["playCount"], 0)
        result = parse_topics(payload([row(count=None)]), "黍")
        self.assertIsNone(result["playCount"])
        self.assertEqual(result["status"], "partial")

    def test_absent_exact_topic_does_not_mean_zero(self):
        result = parse_topics(payload([row("黍cos")]), "黍")
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["playCount"])
        self.assertIsNone(result["topicId"])

    def test_ambiguous_names_and_conflicting_ids_are_rejected(self):
        for rows in [[row(cid="1"), row(cid="2")], [row(cid="1"), row(cid="1", count=99)]]:
            with self.assertRaises(CollectError):
                parse_topics(payload(rows), "黍")

    def test_identical_rows_are_deduplicated(self):
        self.assertEqual(len(parse_topics(payload([row(), row()]), "黍")["returnedTopics"]), 1)

    def test_error_and_malformed_payloads_are_never_empty_success(self):
        for data in [None, {}, {"status_code": 0}, {"status_code": False, "sug_list": []}, {"status_code": 8, "sug_list": []}, payload([row(count=True)]), payload([row(count=-1)]), payload([row(count="1.2亿")])]:
            with self.subTest(data=data), self.assertRaises(CollectError):
                parse_topics(data, "黍")

    def test_source_requests_only_the_summary_api_and_preserves_provenance(self):
        with patch("collector_sources.douyin_topics.Session") as factory:
            response = Mock(status_code=200)
            response.json.return_value = payload([row()])
            factory.return_value.request.return_value = response
            result = DouyinTopics().read("#黍")
        args, kwargs = factory.return_value.request.call_args
        self.assertEqual(args, ("GET", ENDPOINT))
        self.assertEqual(kwargs["params"], {"keyword": "黍", "source": "challenge_create", "aid": "2906"})
        self.assertFalse(kwargs["allow_redirects"])
        self.assertIsNone(result["publishedAt"])
        self.assertIsNone(result["workCount"])
        self.assertIn("observedAt", result)
        self.assertEqual(result["native"]["view_count"], 12)
        response.close.assert_called_once()

    def test_captcha_stops_and_closes_response(self):
        with patch("collector_sources.douyin_topics.Session") as factory:
            response = Mock(status_code=200, content="<title>验证码中间页</title>".encode())
            response.json.side_effect = ValueError()
            factory.return_value.request.return_value = response
            with self.assertRaises(CollectError) as caught:
                DouyinTopics().read("黍")
        self.assertEqual(caught.exception.kind, "blocked")
        response.close.assert_called_once()
        self.assertEqual(factory.return_value.request.call_count, 1)

    def test_failure_keeps_previously_saved_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = root / "douyin" / "probe-topic.json"
            previous.parent.mkdir()
            previous.write_text('{"playCount":12}', encoding="utf-8")
            with patch.object(douyin_collect, "LOCAL", root), patch.object(douyin_collect, "DouyinTopics") as source:
                source.return_value.read.side_effect = CollectError("验证受限", "blocked")
                with self.assertRaises(CollectError):
                    douyin_collect.main(["probe", "--tag", "黍"])
            self.assertEqual(previous.read_text(encoding="utf-8"), '{"playCount":12}')
            self.assertTrue((root / "douyin" / "probe-last-error.json").exists())


if __name__ == "__main__":
    unittest.main()
