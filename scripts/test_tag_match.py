"""角色标签归属的回归测试：精确匹配、命名空间写法与异格形态区分。

口径是"标签命中即归属，不辨真假"，因此这里同时钉住两件容易被改错的事：
同名作品必须计入（钢弹能天使），半截名字必须不算命中（蕾缪安姐姐）。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tag_match import Matcher, load_matcher, normalize, qualified, strip_namespace

MATCHER, OPERATORS = load_matcher()
BY_ID = {o["id"]: o for o in OPERATORS}
BY_NAME = {o["name"]: o for o in OPERATORS}


def find(english):
    for operator in OPERATORS:
        if operator.get("englishName") == english:
            return operator
    raise KeyError(english)


ANGEL = find("Exusiai")
LEMUEN = find("Lemuen")
AMIYA = find("Amiya")
AMIYA_GUARD = BY_NAME["阿米娅(近卫)"]
AMIYA_MEDIC = BY_NAME["阿米娅(医疗)"]
W = BY_NAME["W"]


def hits(tags, operator):
    return MATCHER.evaluate(tags, operator).accepted


class ExactTagTests(unittest.TestCase):
    def test_character_tag_alone_attributes_without_any_game_tag(self):
        self.assertTrue(hits(["蕾缪安"], LEMUEN))
        self.assertTrue(hits(["レミュアン"], LEMUEN))
        self.assertTrue(hits(["Lemuen"], LEMUEN))
        self.assertTrue(hits(["能天使"], ANGEL))

    def test_partial_or_decorated_name_is_not_a_hit(self):
        self.assertFalse(hits(["蕾缪安姐姐"], LEMUEN))
        self.assertFalse(hits(["蕾缪"], LEMUEN))
        self.assertFalse(hits(["能天使exia"], ANGEL))
        self.assertFalse(hits(["原创", "风景"], ANGEL))

    def test_namesake_works_are_counted_not_filtered(self):
        # 明确选择的口径：标签是角色标签就计入，不做同名排除。
        self.assertTrue(hits(["能天使", "gundam", "exia", "扎古"], ANGEL))
        self.assertTrue(hits(["蕾缪安", "蔚蓝档案", "碧蓝档案"], LEMUEN))

    def test_short_and_single_letter_names_still_attribute(self):
        self.assertTrue(hits(["W"], W))
        self.assertTrue(hits(["w"], W))


class NamespaceTests(unittest.TestCase):
    def test_every_namespace_spelling_resolves(self):
        for tag in [
            "能天使(アークナイツ)",
            "能天使(明日方舟)",
            "明日方舟能天使",
            "能天使明日方舟",
            "arknights:exusiai",
            "arknights exusiai",
            "ARKNIGHTS-Exusiai",
        ]:
            self.assertEqual(MATCHER.owners(tag), {ANGEL["id"]}, tag)

    def test_normalize_absorbs_fullwidth_and_case_differences(self):
        self.assertEqual(normalize("Ｅｘｕｓｉａｉ"), "exusiai")
        self.assertEqual(strip_namespace(normalize("明日方舟：能天使")), "能天使")

    def test_bare_franchise_tag_is_not_a_character_hit(self):
        self.assertFalse(hits(["明日方舟", "arknights"], ANGEL))


class OperatorFormTests(unittest.TestCase):
    def test_bracketed_chinese_name_attributes_to_that_form(self):
        self.assertEqual(MATCHER.owners("阿米娅(近卫)"), {AMIYA_GUARD["id"]})
        self.assertEqual(MATCHER.owners("阿米娅(医疗)"), {AMIYA_MEDIC["id"]})

    def test_indistinguishable_foreign_name_goes_to_base_form_only(self):
        # 三个形态的英文名与日文名完全相同，标签区分不了，
        # 只归本体，避免同一件作品被三位重复累计互动指标。
        self.assertEqual(MATCHER.owners("阿米娅"), {AMIYA["id"]})
        self.assertEqual(MATCHER.owners("Amiya"), {AMIYA["id"]})
        self.assertEqual(MATCHER.owners("アーミヤ"), {AMIYA["id"]})
        self.assertFalse(hits(["Amiya"], AMIYA_GUARD))
        self.assertFalse(hits(["Amiya"], AMIYA_MEDIC))

    def test_name_set_does_not_add_stripped_base_name(self):
        self.assertNotIn("阿米娅", MATCHER.name_set(AMIYA_GUARD))
        self.assertIn("阿米娅(近卫)", MATCHER.name_set(AMIYA_GUARD))


class DecisionTests(unittest.TestCase):
    def test_decision_records_attribution_basis(self):
        decision = MATCHER.evaluate(["原创", "能天使", "arknights"], ANGEL)
        self.assertTrue(decision.accepted)
        self.assertEqual(decision.matchedTags, ["能天使"])
        self.assertIn("能天使", decision.reason)
        self.assertEqual(
            sorted(decision.as_dict()), ["accepted", "matchedTags", "reason"]
        )

    def test_no_hit_carries_no_matched_tag(self):
        decision = MATCHER.evaluate(["原创"], ANGEL)
        self.assertFalse(decision.accepted)
        self.assertEqual(decision.matchedTags, [])


class RosterCoverageTests(unittest.TestCase):
    def test_every_operator_has_at_least_one_searchable_name(self):
        for operator in OPERATORS:
            self.assertTrue(MATCHER.name_set(operator), operator["id"])

    def test_index_covers_all_operators(self):
        indexed = {oid for ids in MATCHER.full.values() for oid in ids}
        self.assertEqual(indexed, {o["id"] for o in OPERATORS})

    def test_pixiv_aliases_include_namespace_variants(self):
        aliases = MATCHER.aliases(ANGEL, "pixiv")
        self.assertIn("能天使(アークナイツ)", aliases)
        self.assertIn("能天使(明日方舟)", aliases)
        self.assertIn("Exusiai", aliases)

    def test_youtube_tumblr_bluesky_use_bare_names(self):
        for platform in ("youtube", "tumblr", "bluesky"):
            aliases = MATCHER.aliases(ANGEL, platform)
            self.assertIn("能天使", aliases)
            self.assertNotIn("能天使(アークナイツ)", aliases)

    def test_chinese_platforms_use_prefixed_namespace(self):
        self.assertIn("明日方舟能天使", MATCHER.aliases(ANGEL, "bilibili"))
        self.assertIn("明日方舟能天使", MATCHER.aliases(ANGEL, "xiaohongshu"))


class QualifiedTagTests(unittest.TestCase):
    """限定标签与裸名标签同等有效，但要能分开统计。

    "空""魔王""山"这类名字本身就是常用词，裸名命中里混着大量无关作品；
    数据全部保留，靠这个字段让网站按两种口径分别排行。
    """

    def test_namespace_spelling_is_qualified(self):
        for tag in ["空(明日方舟)", "空(アークナイツ)", "明日方舟魔王", "arknights:山"]:
            self.assertTrue(qualified(tag), tag)

    def test_bare_name_is_not_qualified(self):
        for tag in ["空", "魔王", "山", "能天使", "Exusiai"]:
            self.assertFalse(qualified(tag), tag)

    def test_empty_tag_is_neither(self):
        self.assertFalse(qualified(""))
        self.assertFalse(qualified(None))


if __name__ == "__main__":
    unittest.main()
