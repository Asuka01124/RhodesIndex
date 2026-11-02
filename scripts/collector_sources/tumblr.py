"""tumblr 平台独立 HTTP 适配器。"""

from __future__ import annotations
import json
import re
from urllib.parse import quote, urlsplit
from tag_session import CollectError
from collector_sources.base import Source, Page


class Tumblr(Source):
    platform = "tumblr"

    def __init__(self, interval=0.7):
        super().__init__(interval)
        self.api_token = None

    def initial(self, tag):
        response = self.session.request(
            "GET",
            "https://www.tumblr.com/tagged/" + quote(tag, safe=""),
            params={"sort": "recent"},
        )
        text = response.text
        response.close()
        marker = re.search(r'<script[^>]+id=["\']___INITIAL_STATE___["\'][^>]*>', text)
        if not marker:
            raise CollectError(
                "Tumblr 未提供标签原始 JSON，未启动浏览器回退。", "blocked"
            )
        try:
            state = json.JSONDecoder().raw_decode(text[marker.end() :].lstrip())[0]
            self.api_token = state.get("apiFetchStore", {}).get("API_TOKEN")
            queries = state.get("queries", {}).get("queries", [])
            query = next(
                q
                for q in queries
                if str(q.get("queryKey", [""])[0]).startswith("hubsTimeline-")
            )
            return query["state"]["data"]["pages"][0]
        except (ValueError, KeyError, IndexError, StopIteration):
            raise CollectError("Tumblr 标签流结构不可识别，不能记为空结果。") from None

    def page(self, tag, kind, cursor):
        if not cursor:
            page = self.initial(tag)
            body = page.get("items", [])
            next_link = page.get("nextLink")
        else:
            if not self.api_token:
                self.initial(tag)
            parts = urlsplit(cursor)
            if parts.netloc or not parts.path.startswith("/v2/"):
                raise CollectError("Tumblr 下一页地址不在预期 API 路径内。")
            result = self.session.json(
                "GET",
                "https://www.tumblr.com/api" + cursor,
                headers={
                    "Authorization": "Bearer " + (self.api_token or ""),
                    "Referer": "https://www.tumblr.com/tagged/" + quote(tag, safe=""),
                },
            )
            timeline = result.get("response", {}).get("timeline")
            if not isinstance(timeline, dict) or not isinstance(
                timeline.get("elements"), list
            ):
                raise CollectError("Tumblr 下一页未返回作品流。", "blocked")
            body = timeline["elements"]
            n = timeline.get("_links", {}).get("next")
            next_link = n.get("href") if isinstance(n, dict) else n
        posts = {}
        for node in self.timeline_posts(body):
            posts[str(node["id"])] = {"id": str(node["id"]), "post": node}
        return Page(list(posts.values()), next_link, not next_link)

    @staticmethod
    def timeline_posts(value):
        """只取时间流自身的作品节点，跳过 trail 里的被转发原作。

        trail 是转发链，里面的 post 属于原作者。把它当独立作品收进来会有三重
        错误：转发者的角色标签被算到原作上、收进早于游戏发行的历史条目、
        同一份互动指标随转发次数被重复累计。
        """
        if isinstance(value, dict):
            if (
                value.get("objectType") or value.get("object_type")
            ) == "post" and value.get("id"):
                yield value
            for key, item in value.items():
                if key in ("trail", "reblogTrail"):
                    continue
                yield from Tumblr.timeline_posts(item)
        elif isinstance(value, list):
            for item in value:
                yield from Tumblr.timeline_posts(item)

    def detail(self, item, kind):
        b = item["post"]
        likes = b.get("likeCount", b.get("like_count"))
        trail = b.get("trail") or b.get("reblogTrail") or []
        root = next(
            (
                str(entry["post"]["id"])
                for entry in trail
                if isinstance(entry, dict)
                and isinstance(entry.get("post"), dict)
                and entry["post"].get("id")
            ),
            None,
        )
        work = self.observation(
            item["id"],
            b.get("summary"),
            b.get("postUrl") or b.get("post_url"),
            b.get("timestamp"),
            likes,
            None,
            b.get("tags", []),
            {
                "likeCount": likes,
                "reblogCount": b.get("reblogCount", b.get("reblog_count")),
                "noteCount": b.get("noteCount", b.get("note_count")),
            },
        )
        # 转发与其原作的关系单独记录；likes 始终是这一条自己的点赞数，
        # 不含转发链上其他条目的互动。
        work["rootId"] = root
        work["isReblog"] = root is not None
        return work
