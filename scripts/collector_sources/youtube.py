"""youtube 平台独立 HTTP 适配器。"""

from __future__ import annotations
import json
import re
from urllib.parse import quote
from tag_session import CollectError, exact_count
from collector_sources.base import Source, Page


def embedded_json(text, variable):
    pattern = re.compile(r"(?:var\s+)?" + re.escape(variable) + r"\s*=\s*")
    match = pattern.search(text)
    if not match:
        raise CollectError("网页未返回可识别的原始 JSON，未使用渲染浏览器回退。")
    try:
        return json.JSONDecoder().raw_decode(text[match.end() :])[0]
    except ValueError:
        raise CollectError("网页原始 JSON 无法解析。") from None


def walk(value):
    if isinstance(value, dict):
        yield value
        for v in value.values():
            yield from walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from walk(v)


class Youtube(Source):
    platform = "youtube"

    def __init__(self, interval=0.7):
        super().__init__(interval)
        self.context = {}

    def page(self, tag, kind, cursor):
        if cursor:
            if not isinstance(cursor, dict) or cursor.get("endpoint") not in (
                "/youtubei/v1/browse",
                "/youtubei/v1/search",
            ):
                raise CollectError("YouTube 分页游标结构无效。")
            if not self.context:
                self.initial(tag)  # 恢复时只重新获取公开客户端上下文，不重新计算分页。
            d = self.session.json(
                "POST",
                "https://www.youtube.com" + cursor["endpoint"],
                json={"context": self.context, "continuation": cursor["token"]},
            )
        else:
            d = self.initial(tag)
        items = {}
        cursors = []
        for node in walk(d):
            renderer = (
                node.get("videoRenderer")
                or node.get("gridVideoRenderer")
                or node.get("reelItemRenderer")
            )
            if renderer and renderer.get("videoId"):
                items[renderer["videoId"]] = {"id": renderer["videoId"]}
            short = (
                node.get("shortsLockupViewModel", {})
                .get("onTap", {})
                .get("innertubeCommand", {})
                .get("reelWatchEndpoint", {})
                .get("videoId")
            )
            if short:
                items[short] = {"id": short}
            continuation = node.get("continuationItemRenderer", {}).get(
                "continuationEndpoint", {}
            )
            token = continuation.get("continuationCommand", {}).get("token")
            endpoint = (
                continuation.get("commandMetadata", {})
                .get("webCommandMetadata", {})
                .get("apiUrl", "/youtubei/v1/browse")
            )
            if token:
                cursors.append({"token": token, "endpoint": endpoint})
        return Page(list(items.values()), cursors[-1] if cursors else None, not cursors)

    def initial(self, tag):
        response = self.session.request(
            "GET", "https://www.youtube.com/hashtag/" + quote(tag, safe="")
        )
        text = response.text
        response.close()
        if re.search("sign in to confirm|unusual traffic|确认您不是机器人", text, re.I):
            raise CollectError("YouTube 返回登录或验证页。", "blocked")
        # ytcfg.set 内含公开客户端上下文，不含账号凭据。
        for match in re.finditer(r"ytcfg\.set\(\s*", text):
            try:
                config = json.JSONDecoder().raw_decode(text[match.end() :])[0]
                if config.get("INNERTUBE_CONTEXT"):
                    self.context = config["INNERTUBE_CONTEXT"]
            except (ValueError, AttributeError):
                pass
        return embedded_json(text, "ytInitialData")

    def detail(self, item, kind):
        id = item["id"]
        response = self.session.request(
            "GET", "https://www.youtube.com/watch", params={"v": id}
        )
        text = response.text
        response.close()
        d = embedded_json(text, "ytInitialPlayerResponse")
        b = d.get("videoDetails")
        if not b:
            raise CollectError("YouTube 未返回作品原生指标。")
        meta = d.get("microformat", {}).get("playerMicroformatRenderer", {})
        title = b.get("title", "")
        tags = list(b.get("keywords", [])) + re.findall(r"#([^\s#]+)", title)
        likes = None
        try:
            initial = embedded_json(text, "ytInitialData")
            for node in walk(initial):
                toggle = node.get("toggleButtonRenderer")
                if toggle and ("LIKE" in str(toggle.get("defaultIcon", {}))):
                    label = (
                        toggle.get("defaultText", {})
                        .get("accessibility", {})
                        .get("accessibilityData", {})
                        .get("label", "")
                    )
                    m = re.search(
                        r"([\d,，]+)\s*(?:likes|个赞|位用户喜欢)", label, re.I
                    )
                    if m:
                        likes = exact_count(m[1].replace(",", "").replace("，", ""))
        except CollectError:
            pass
        return self.observation(
            id,
            title,
            f"https://www.youtube.com/watch?v={id}",
            meta.get("publishDate"),
            likes,
            b.get("viewCount"),
            tags,
            {"likeCount": likes, "viewCount": b.get("viewCount")},
            "metadata_tag",
        )
