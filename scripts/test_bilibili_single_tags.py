"""验证新旧口径隔离、形态归属、合计、缺失、来源及恢复断点。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bilibili_single_tags import (FORM_BASE_IDS, RULE, SingleTagSource, BilibiliSingleTagCollector,
                                 character_groups, count_snapshot, make_plan)
from lofter_tag_stats import TagStatsStore


ROSTER = [{"id": "char_002_amiya", "name": "阿米娅"},
          {"id": "char_1001_amiya2", "name": "阿米娅(近卫)"},
          {"id": "char_1037_amiya3", "name": "阿米娅(医疗)"},
          {"id": "shu", "name": "黍"}]


class SingleTagTests(unittest.TestCase):
    def test_all_known_forms_have_valid_explicit_base(self):
        root = Path(__file__).resolve().parents[1]
        roster = json.loads((root / "public/data/operators.json").read_text(encoding="utf-8"))
        self.assertEqual(len(FORM_BASE_IDS), 40)
        self.assertTrue(set(FORM_BASE_IDS).isdisjoint(FORM_BASE_IDS.values()))
        self.assertEqual(len(character_groups(roster)), 394)
        self.assertEqual(FORM_BASE_IDS["char_1035_wisdel"], "char_113_cqbw")
        self.assertEqual(FORM_BASE_IDS["char_1050_chen3"], "char_010_chen")

    def test_single_tag_source_preserves_real_zero_and_null_for_missing(self):
        with patch("collector_sources.bilibili_counts.Session"):
            source = SingleTagSource()
        source.session.json.return_value = {"code": 0, "data": {
            "tag_id": 1, "tag_name": "黍", "count": {"use": 0, "atten": 2, "view": 0}}}
        row = source.read("黍")
        self.assertEqual(row["countBasis"], "native_tag_use")
        self.assertEqual(row["workCount"], 0)
        self.assertEqual(source.session.json.call_args.kwargs["params"], {"tag_name": "黍"})
        source.session.json.return_value = {"code": 16001}
        row = source.read("阿米娅(医疗)")
        self.assertIsNone(row["workCount"])
        self.assertEqual(row["status"], "unavailable")

    def test_export_sums_tag_uses_without_claiming_deduplicated_works(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "public/data").mkdir(parents=True)
            (root / "public/data/operators.json").write_text(json.dumps(ROSTER), encoding="utf-8")
            store = TagStatsStore(root / ".local", "bilibili")
            for item in make_plan(ROSTER)[:2]:
                store.put("new", item, {"tag": item["tag"], "countBasis": "native_tag_use", "rule": RULE,
                          "workCount": 10, "nativeMetrics": {"count.use": 10}, "status": "completed",
                          "observedAt": "2026-11-07T00:00:00Z", "tagId": 1})
            # 旧组合搜索的记录不能混入新的单 TAG 合计。
            store.put("old", {"key": "黍", "tag": "黍", "operatorIds": ["shu"], "scope": "search"},
                      {"tag": "黍", "workCount": 999, "countBasis": "search_result_total"})
            result = count_snapshot(root, root)
            amiya, shu = result["records"]
            self.assertEqual(amiya["workCount"], 20)
            self.assertEqual(len(amiya["sharedOperatorIds"]), 3)
            self.assertTrue(amiya["lowerBound"])
            self.assertFalse(amiya["complete"])
            self.assertIn("不是去重作品总数", amiya["coverageNote"])
            self.assertIsNone(shu["workCount"])
            self.assertEqual(len(result["records"]), 2)
            self.assertEqual(result["metadata"]["availableTags"], 2)
            store.db.close()

    def test_duplicate_tag_queried_once_and_old_run_never_resumed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = TagStatsStore(root, "bilibili")
            source = type("Source", (), {"requests": 0})()
            collector = BilibiliSingleTagCollector(ROSTER, store=store, source=source, runtime=root / "run")
            self.assertTrue(all(x["key"].startswith("single_tag_v1:") for x in collector.plan))
            collector.publish()
            resumed = BilibiliSingleTagCollector(ROSTER, store=store, source=source, runtime=root / "run")
            self.assertEqual(collector.job["id"], resumed.job["id"])
            job_file = root / "run/http-job.json"
            job = json.loads(job_file.read_text(encoding="utf-8")); job["kind"] = "search_result_count"
            job_file.write_text(json.dumps(job), encoding="utf-8")
            fresh = BilibiliSingleTagCollector(ROSTER, store=store, source=source, runtime=root / "run")
            self.assertNotEqual(fresh.job["id"], collector.job["id"])
            self.assertEqual(len(make_plan([*ROSTER, ROSTER[0]])), 4)
            store.db.close()


if __name__ == "__main__":
    unittest.main()
