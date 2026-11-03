"""话题网站快照：共享人物只保留一条，原生值、空值和来源可追溯。"""

from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlencode

from collector_sources.douyin_topics import ENDPOINT
from douyin_topic_export import export_counts
from lofter_tag_stats import TagStatsStore
from tag_store import atomic_json


OPS = [{"id": "char_002_amiya", "name": "阿米娅"},
       {"id": "char_1001_amiya2", "name": "阿米娅(近卫)"},
       {"id": "char_1037_amiya3", "name": "阿米娅(医疗)"},
       {"id": "castle", "name": "Castle-3"}]


class DouyinExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        atomic_json(self.root / "public/data/operators.json", OPS)
        self.row = {
            "tag": "阿米娅", "operatorIds": [operator["id"] for operator in OPS[:3]],
            "topicId": "123", "status": "ok", "playCount": 0, "native": {"view_count": 0},
            "observedAt": "2026-11-03T00:00:00Z",
            "sourceUrl": ENDPOINT + "?" + urlencode({"keyword": "阿米娅", "source": "challenge_create", "aid": "2906"}),
            "returnedTopics": [{"tag": "无关话题", "playCount": 99}],
        }
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        atomic_json(self.root / ".local/douyin/topic-counts.json", {"metadata": {"runId": "run"}, "records": [self.row]})

    def test_shared_topic_is_not_copied_or_summed_and_missing_is_not_zero(self):
        store = TagStatsStore(self.root / ".local", "douyin")
        store.fail("run", "Castle-3", "failed", "未返回有效话题ID")
        store.db.close()
        data = export_counts(self.root)
        self.assertEqual(len(data["records"]), 2)
        self.assertEqual(data["records"][0]["playCount"], 0)
        self.assertEqual(len(data["records"][0]["operatorIds"]), 3)
        self.assertIsNone(data["records"][1]["playCount"])
        self.assertEqual(data["records"][1]["missingReason"], "未返回有效话题ID")
        self.assertEqual(data["metadata"]["plannedOperators"], 4)
        self.assertEqual(data["metadata"]["plannedTags"], 2)
        self.assertEqual(data["metadata"]["availableTags"], 1)
        self.assertEqual(data["records"][0]["observedAt"], self.row["observedAt"])
        self.assertEqual(data["records"][0]["apiSourceUrl"], self.row["sourceUrl"])
        self.assertNotIn("returnedTopics", data["records"][0])
        self.assertNotIn("workCount", data["records"][0])
        self.assertTrue((self.root / "public/data/douyin-tag-counts.json").is_file())

    def test_mismatched_native_count_or_source_cannot_be_shown_as_valid(self):
        self.row["native"]["view_count"] = 1
        self.write()
        self.assertIsNone(export_counts(self.root)["records"][0]["playCount"])
        self.row["native"]["view_count"] = 0
        self.row["sourceUrl"] = "https://other.example/"
        self.write()
        self.assertIsNone(export_counts(self.root)["records"][0]["playCount"])

    def test_missing_time_or_placeholder_id_is_not_valid_provenance(self):
        for key, value in [("observedAt", None), ("topicId", "0")]:
            with self.subTest(key=key):
                original = self.row[key]
                self.row[key] = value
                self.write()
                self.assertIsNone(export_counts(self.root)["records"][0]["playCount"])
                self.row[key] = original


if __name__ == "__main__":
    unittest.main()
