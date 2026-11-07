"""B站标签累计使用计数；每个标签一次 HTTP，不读取视频明细。"""

from urllib.parse import urlencode
import unicodedata

from collector_sources.base import now
from tag_session import CollectError, Session, exact_count


class BilibiliCounts:
    endpoint = "https://api.bilibili.com/x/tag/info"

    def __init__(self, interval=3.5):
        self.session = Session("bilibili", interval, retries=2)
        self.requests = 0
        self.cancelled = lambda: False

    def read(self, tag):
        if self.cancelled():
            raise CollectError("已请求停止，保留当前标签断点。", "cancelled")
        queried_tag = tag
        def request(name):
            self.requests += 1
            return self.session.json(
                "GET", self.endpoint, params={"tag_name": name},
                headers={"Referer": "https://www.bilibili.com/"},
            )
        body = request(queried_tag)
        alternate = tag.translate(str.maketrans("()", "（）"))
        if isinstance(body, dict) and body.get("code") == 16001 and alternate != tag:
            if self.cancelled():
                raise CollectError("已请求停止，保留当前标签断点。", "cancelled")
            queried_tag = alternate
            body = request(queried_tag)
        if not isinstance(body, dict):
            raise CollectError("B站标签接口返回结构不可识别。")
        code = body.get("code")
        if code in (-101, -111, -352, -412, -509, -799):
            raise CollectError(f"B站标签接口受限（代码 {code}），保存停止。", "blocked")
        if code != 0 or not isinstance(body.get("data"), dict):
            raise CollectError(f"B站标签统计不可读取（代码 {code}）；数量未写成 0。",
                               "unavailable" if code == 16001 else "failed")
        data = body["data"]
        tag_id = exact_count(data.get("tag_id"))
        counts = data.get("count")
        count = exact_count(counts.get("use")) if isinstance(counts, dict) else None
        native_tag = data.get("tag_name")
        if (tag_id is None or not isinstance(native_tag, str)
                or unicodedata.normalize("NFKC", native_tag) != unicodedata.normalize("NFKC", tag)
                or count is None):
            raise CollectError("标签名称、ID 或 count.use 不可核验；未猜测作品数。")
        return {
            "platform": "bilibili", "kind": "tag_count", "tag": tag,
            "tagId": tag_id, "nativeTag": native_tag, "workCount": count, "status": "completed",
            "url": f"https://www.bilibili.com/tag/{tag_id}",
            "apiSourceUrl": self.endpoint + "?" + urlencode({"tag_name": queried_tag}),
            "observedAt": now(), "publishedAt": None, "year": None,
            "timeBasis": "all_time_at_observation", "annualCounts": None,
            "yearBreakdownStatus": "not_verified_supported",
            "missing": {"annualCounts": "标签统计接口未提供可核验的发布时间年度拆分。"},
            "nativeMetrics": {"count.use": count, "count": dict(counts)},
            "methodology": "平台原生标签使用计数，未逐件核验可访问视频；不同标签不相加。",
        }
