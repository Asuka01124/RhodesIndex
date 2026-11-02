"""只读取 LOFTER 标签页头部的浏览和参与，不请求作品列表或详情。"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re
import threading
import time
from urllib.parse import quote, urlsplit

from collector_sources.base import now
from tag_session import CollectError, Session


NUMBER = r"[0-9][0-9,]*(?:\.[0-9]+)?[万亿wW]?\+?"
PAIR = re.compile(rf"(?P<views>{NUMBER})\s*浏览\s*(?P<participation>{NUMBER})\s*参与")


def display_count(text):
    """缩写只产生明确标注的估计值，绝不冒充精确整数。"""
    raw = text.strip()
    match = re.fullmatch(r"(\d+(?:,\d{3})*(?:\.\d+)?)([万亿wW]?)(\+?)", raw)
    if not match:
        raise CollectError("标签页的显示计数格式不可识别，未当作 0。")
    number, unit, plus = match.groups()
    if "," in number and not re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", number):
        raise CollectError("标签页计数的千位分隔格式无效。")
    try:
        numeric = Decimal(number.replace(",", "")) * {
            "": 1, "万": 10000, "w": 10000, "W": 10000, "亿": 100000000,
        }[unit]
    except InvalidOperation:
        raise CollectError("标签显示计数无法解析。") from None
    if numeric < 0 or numeric != numeric.to_integral_value() or numeric > 9007199254740991:
        raise CollectError("标签计数不是可保存的非负整数。")
    value = int(numeric)
    exact = not unit and not plus and "." not in number
    return {
        "display": raw, "exact": exact,
        "value": value if exact else None,
        "estimate": None if exact else value,
        "atLeast": value if plus else None,
    }


class TagHeader(HTMLParser):
    """只接受真实 tag-count 容器，排除导航的浏览字样、广告和脚本中的数字。"""

    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.capture_depth = None
        self.parts = []
        self.headers = []

    def handle_starttag(self, tag, attrs):
        if tag in self.VOID:
            return
        self.stack.append(tag)
        classes = dict(attrs).get("class", "").split()
        if "tag-count" in classes:
            if self.capture_depth is not None:
                raise CollectError("标签统计容器发生嵌套，未猜测统计值。")
            self.capture_depth = len(self.stack)
            self.parts = []

    def handle_startendtag(self, tag, attrs):
        if tag not in self.VOID:
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag not in self.stack:
            return
        index = len(self.stack) - 1 - self.stack[::-1].index(tag)
        if self.capture_depth is not None and index < self.capture_depth:
            self.headers.append(" ".join(self.parts).replace("\xa0", " "))
            self.capture_depth = None
            self.parts = []
        self.stack = self.stack[:index]

    def handle_data(self, text):
        if self.capture_depth is not None and not any(t in ("script", "style") for t in self.stack):
            self.parts.append(text)

    def result(self):
        found = set()
        for text in self.headers:
            for match in PAIR.finditer(text):
                found.add((match["views"], match["participation"]))
        if not found:
            raise CollectError("页面没有可识别的标签浏览／参与统计，可能需要登录或页面结构已变；未写成 0。")
        if len(found) != 1:
            raise CollectError("页面有冲突的标签统计，未随意挑选较大值。")
        views, participation = found.pop()
        return display_count(views), display_count(participation)


class LofterTags:
    def __init__(self, interval=3.5):
        self.interval = interval
        self.session = Session("lofter", interval)
        self.gate = threading.Lock()
        self.last_request = 0.0
        self.requests = 0
        self.cancelled = lambda: False

    def read(self, tag):
        url = "https://www.lofter.com/tag/" + quote(tag, safe="") + "/new"
        with self.gate:
            while True:
                if self.cancelled():
                    raise CollectError("已请求停止，标签将在下次继续。", "cancelled")
                wait = self.interval - (time.monotonic() - self.last_request)
                if wait <= 0:
                    break
                time.sleep(min(wait, 0.2))
            self.last_request = time.monotonic()
            self.requests += 1
            response = self.session.request("GET", url, allow_redirects=False)
        try:
            if 300 <= response.status_code < 400:
                if urlsplit(response.headers.get("Location", "")).path == "/wall":
                    missing = {"display": None, "exact": False, "value": None, "estimate": None, "atLeast": None}
                    return {
                        "platform": "lofter", "kind": "tag_summary", "tag": tag,
                        "url": url, "views": dict(missing), "participation": dict(missing),
                        "status": "unavailable",
                        "missingReason": "标签页跳转到 /wall，当前无法取得统计；未推断为零，具体原因待核验。",
                        "observedAt": now(), "timeBasis": "all_time_at_observation",
                        "aggregation": "per_tag_do_not_sum",
                    }
                raise CollectError("标签页返回登录或验证重定向，已保留进度。", "blocked")
            if "html" not in response.headers.get("Content-Type", "").lower():
                raise CollectError("标签页未返回 HTML，未把异常内容当成 0。")
            parser = TagHeader()
            parser.feed(response.text)
            views, participation = parser.result()
        finally:
            response.close()
        return {
            "platform": "lofter", "kind": "tag_summary", "tag": tag,
            "url": url, "views": views, "participation": participation,
            "observedAt": now(), "timeBasis": "all_time_at_observation",
            "aggregation": "per_tag_do_not_sum", "status": "ok",
        }
