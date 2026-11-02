"""角色标签归属：原生标签精确等于角色别名即归属，不判断作品真假。

标签命中就算命中——不做同名排除、不看游戏语境、不设待复核分类。
"能天使"标签下的钢弹模型、"蕾缪安"标签下的蔚蓝档案同人，一律计入该干员，
这是明确选择的口径：宁可多算同名作品，也不因为语境判断把真作品漏掉。

标签写法差异由 normalize 与命名空间剥离吸收：NFKC 归一 + casefold，再去掉
明日方舟／アークナイツ／arknights 的括号、前缀、后缀与冒号分隔，因此
"能天使(アークナイツ)"、"明日方舟能天使"、"arknights:exusiai" 都算能天使的标签。

唯一需要区分的是异格形态：阿米娅／阿米娅(近卫)／阿米娅(医疗) 的英文名与
日文名完全相同，标签层面无法区分。这类区分不了的裸别名只归到不带括号标注
的本体，避免同一件作品的互动指标被三位重复累计；带标注的中文名各自归属。
"""

from __future__ import annotations
from pathlib import Path
import json
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]

FORM = re.compile(r"[（(][^）)]*[）)]")
NAMESPACE = (
    re.compile(r"[（(]\s*(?:明日方舟|アークナイツ|arknights)\s*[）)]"),
    re.compile(r"^(?:明日方舟|アークナイツ|arknights)[:：_\- ]*"),
    re.compile(r"(?:明日方舟|アークナイツ|arknights)[:：_\- ]*$"),
)


def normalize(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def strip_namespace(alias):
    for pattern in NAMESPACE:
        alias = pattern.sub("", alias).strip()
    return alias


def qualified(tag):
    """标签是否自带作品系列命名空间（明日方舟／アークナイツ／arknights）。

    裸名标签（"空"）与限定标签（"空(明日方舟)"）在归属上同等有效，都算命中；
    区别只在于后者能自证这件作品属于本作。像"空""魔王""山"这种名字本身就是
    常用词的干员，裸名命中里混着大量无关作品，网站据此分别统计两种口径，
    既不丢数据，也不让"天空"图把干员排行冲垮。
    """
    n = normalize(tag)
    return bool(n) and strip_namespace(n) != n


class Decision:
    """归属结论；matchedTags 与 reason 作为归属依据逐件落库。"""

    __slots__ = ("accepted", "matchedTags", "reason")

    def __init__(self, accepted, matched_tags, reason):
        self.accepted = accepted
        self.matchedTags = matched_tags
        self.reason = reason

    def as_dict(self):
        return {
            "accepted": self.accepted,
            "matchedTags": self.matchedTags,
            "reason": self.reason,
        }


class Matcher:
    """按花名册建立别名索引；档案只加载一次，全部干员共享同一份索引。"""

    def __init__(self, operators):
        self.operators = {o["id"]: o for o in operators}
        self.full = {}
        self.base = {}
        for operator in operators:
            oid = operator["id"]
            for alias in self.name_set(operator):
                n = normalize(alias)
                if not n:
                    continue
                self.full.setdefault(n, set()).add(oid)
                stripped = normalize(FORM.sub("", n))
                if stripped:
                    self.base.setdefault(stripped, set()).add(oid)

    @staticmethod
    def name_set(operator):
        """中／日／英名原样返回，不主动去掉异格括号标注。

        去标注会让 阿米娅(近卫) 把 "阿米娅" 当成自己的检索标签，
        从而把本体的作品算进近卫；区分只在 owners() 归属时做一次。
        """
        out = []
        for key in ("name", "japaneseName", "englishName"):
            name = operator.get(key)
            if name:
                out.append(name)
        return list(dict.fromkeys(out))

    def owners(self, tag):
        """标签归属的干员 id 集合；命中不到任何别名时返回空集。"""
        n = strip_namespace(normalize(tag))
        if not n:
            return set()
        ids = self.full.get(n) or self.base.get(n) or set()
        if len(ids) > 1:
            bare = {i for i in ids if not FORM.search(self.operators[i]["name"])}
            if bare:
                ids = bare
        return set(ids)

    def aliases(self, operator, platform):
        """该平台实际遍历的检索标签，含命名空间变体。"""
        names = self.name_set(operator)
        if platform == "pixiv":
            out = []
            for name in names:
                out += [name, f"{name}(アークナイツ)", f"{name}(明日方舟)"]
            return list(dict.fromkeys(out))
        if platform in ("youtube", "tumblr", "bluesky"):
            return list(dict.fromkeys(names))
        return list(dict.fromkeys(names + [f"明日方舟{n}" for n in names]))

    def evaluate(self, tags, operator):
        oid = operator["id"]
        matched = [t for t in (tags or []) if t and oid in self.owners(t)]
        if not matched:
            return Decision(False, [], "原生标签未命中该干员的任何别名。")
        return Decision(
            True,
            matched,
            "原生标签精确等于该干员别名：%s。" % "、".join(matched[:5]),
        )

    def attribute(self, tags):
        """一批原生标签归属到的全部干员：{operatorId: [命中的标签]}。

        一件作品同时打了多名干员的标签时每名都算命中；这样检索某个角色时
        顺带发现的其他角色作品不会漏掉，也不必为每位干员重复请求详情。
        """
        out = {}
        for tag in tags or []:
            if not tag:
                continue
            for oid in self.owners(tag):
                out.setdefault(oid, []).append(tag)
        return out


def load_matcher():
    operators = json.loads(
        (ROOT / "public/data/operators.json").read_text(encoding="utf-8")
    )
    return Matcher(operators), operators
