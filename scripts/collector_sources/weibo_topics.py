"""读取微博话题详情的公开汇总。"""

import html
import math
import re
from urllib.parse import urlencode

from collector_sources.base import now
from collector_sources.lofter_tags import display_count
from tag_session import CollectError, Session


ENDPOINT = "https://m.s.weibo.com/topic/detail"
METRICS = {"原创人数": "originalAuthors", "讨论次数": "discussions", "阅读次数": "reads"}
HEADING = re.compile(r"<h4\b[^>]*>(.*?)</h4\s*>", re.I | re.S)
LIST_ITEM = re.compile(r"<li\b[^>]*>(.*?)</li\s*>", re.I | re.S)
COUNTER = re.compile(
    r"\s*<span\b[^>]*>(.*?)</span\s*>\s*(原创人数|讨论次数|阅读次数)\s*",
    re.I | re.S,
)


def visible_text(markup):
    return html.unescape(re.sub(r"<[^>]*>", "", markup)).strip()


def parse_topic_counts(document, tag):
    document = re.sub(r"<!--.*?-->|<(script|style)\b[^>]*>.*?</\1\s*>", "", document, flags=re.I | re.S)
    headings = list(HEADING.finditer(document))
    labels = [visible_text(heading[1]) for heading in headings]
    if not labels or labels[0] != f"#{tag}#":
        raise CollectError("未返回请求话题的详情页，可能需要登录或验证，已暂停。", "blocked")

    counts = dict.fromkeys(METRICS.values())
    if "数据总览" not in labels:
        if "热搜数据" in labels and "实时热度" in labels:
            return counts
        raise CollectError("微博话题页结构无法识别，已暂停检查。", "blocked")

    index = labels.index("数据总览")
    end = headings[index + 1].start() if index + 1 < len(headings) else len(document)
    overview = document[headings[index].end():end]
    seen = set()
    for item in LIST_ITEM.finditer(overview):
        match = COUNTER.fullmatch(item[1])
        if not match:
            continue
        raw, label = visible_text(match[1]), match[2]
        if label in seen:
            raise CollectError("同一话题的统计字段重复，未选取任一数值。")
        seen.add(label)
        if raw not in ("", "暂无", "暂无数据", "-", "--", "—"):
            counts[METRICS[label]] = display_count(raw)
    if not seen:
        raise CollectError("微博数据总览格式无法识别，已暂停检查。", "blocked")
    return counts


class WeiboTopics:
    def __init__(self, interval=3.5):
        if not math.isfinite(interval) or interval < 3.5:
            raise CollectError("微博话题请求间隔至少为 3.5 秒。")
        self.session = Session("weibo", interval, retries=2)
        self.requests = 0
        self.cancelled = lambda: False

    def read(self, tag):
        tag = tag.strip().strip("#").strip()
        if not tag or "#" in tag or any(ord(char) < 32 for char in tag):
            raise CollectError("请提供一个有效的微博话题名。")
        if self.cancelled():
            raise CollectError("已请求保存停止。", "cancelled")

        params = {"q": f"#{tag}#"}
        self.requests += 1
        with self.session.request("GET", ENDPOINT, params=params, allow_redirects=False) as response:
            if 300 <= response.status_code < 400:
                raise CollectError("微博话题页发生重定向，已暂停以核对登录或验证状态。", "blocked")
            counts = parse_topic_counts(response.content.decode("utf-8", errors="replace"), tag)

        authors = counts["originalAuthors"]
        return {
            "platform": "weibo",
            "kind": "topic_summary",
            "tag": tag,
            "sourceUrl": ENDPOINT + "?" + urlencode(params),
            "observedAt": now(),
            "publishedAt": None,
            "timeBasis": "all_time_at_observation",
            "nativeMetrics": counts,
            "status": "unavailable" if authors is None else "ok" if all(counts.values()) else "partial",
            "missingReason": "话题页未提供原创人数。" if authors is None else None,
        }
