"""B站交集规则：原生中文角色标签 AND 明日方舟 AND 联动作品标签。"""

import unicodedata
from itertools import product


COLLABORATIONS = [
    (["彩虹六号", "彩虹六号：围攻", "彩虹六号:围攻"], [
        "char_456_ash", "char_457_blitz", "char_458_rfrost", "char_459_tachak",
        "char_4123_ela", "char_4124_iana", "char_4125_rdoc", "char_4126_fuze"]),
    (["九色鹿"], ["char_4019_ncdeer"]),
    (["罗小黑战记"], ["char_4067_lolxh"]),
    (["怪物猎人"], ["char_1029_yato2", "char_1030_noirc2", "char_4077_palico",
                   "char_1048_orchd2", "char_1049_catap2", "char_4215_buddy"]),
    (["迷宫饭"], ["char_4141_marcil", "char_4142_laios", "char_4143_sensi", "char_4144_chilc"]),
    (["Ave Mujica", "AveMujica", "BanG Dream! Ave Mujica", "颂乐人偶"], [
        "char_4182_oblvns", "char_4183_mortis", "char_4184_dolris", "char_4185_amoris", "char_4186_tmoris"]),
    (["女神异闻录3", "女神异闻录3 Reload", "女神异闻录3Reload", "P3R"], [
        "char_4217_makoto", "char_4218_aigis", "char_4219_yukari", "char_4220_kormr"]),
]


def normalize(tag):
    return unicodedata.normalize("NFKC", tag).strip().casefold()


def rules_for(operator):
    groups = [[operator["name"]], ["明日方舟"]]
    for names, ids in COLLABORATIONS:
        if operator["id"] in ids:
            groups.append(names)
            break
    return groups


def matches_tags(tags, groups):
    available = {normalize(tag) for tag in tags}
    return all(any(normalize(tag) in available for tag in group) for group in groups)


def search_keyword(groups):
    return " ".join(group[0] for group in groups)


def search_keywords(groups):
    # 同一联动作品的等价原生标签分别检索，最终按BVID去重，避免只搜首个写法漏项。
    result, seen = [], set()
    for variant in product(*groups):
        query = " ".join(variant)
        if normalize(query) not in seen:
            result.append(query)
            seen.add(normalize(query))
    return result
