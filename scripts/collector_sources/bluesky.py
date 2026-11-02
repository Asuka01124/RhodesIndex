"""bluesky 平台独立 HTTP 适配器。"""

from __future__ import annotations
from tag_session import CollectError
from collector_sources.base import Source, Page


class Bluesky(Source):
    platform = "bluesky"

    def page(self, tag, kind, cursor):
        params = {"q": "#" + tag, "tag": tag, "limit": 100, "sort": "latest"}
        if cursor:
            params["cursor"] = cursor
        d = self.session.json(
            "GET",
            "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts",
            params=params,
        )
        rows = d.get("posts")
        if not isinstance(rows, list):
            raise CollectError("Bluesky 搜索接口不可读。", "blocked")
        return Page(
            [{"id": row["uri"], "post": row} for row in rows if row.get("uri")],
            d.get("cursor"),
            not d.get("cursor"),
        )

    def detail(self, item, kind):
        b = item["post"]
        r = b.get("record", {})
        tags = [
            feature["tag"]
            for facet in r.get("facets", [])
            for feature in facet.get("features", [])
            if feature.get("tag")
        ]
        uri = b["uri"]
        parts = uri.split("/")
        return self.observation(
            uri,
            r.get("text", ""),
            f"https://bsky.app/profile/{parts[2]}/post/{parts[-1]}",
            r.get("createdAt"),
            b.get("likeCount"),
            None,
            tags,
            {"likeCount": b.get("likeCount"), "repostCount": b.get("repostCount")},
        )
