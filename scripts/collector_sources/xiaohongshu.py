"""xiaohongshu 平台独立 HTTP 适配器。"""

from __future__ import annotations
import json
from tag_session import CollectError
from collector_sources.base import Source, Page


class Xiaohongshu(Source):
    platform = "xiaohongshu"

    def __init__(self, interval=0.7):
        super().__init__(interval)
        if not self.session.cookies.get("web_session") or not self.session.cookies.get(
            "a1"
        ):
            raise CollectError(
                "缺少小红书登录会话，请在本机隐藏输入 Cookie。", "blocked"
            )
        try:
            from xhshow import Xhshow
        except ImportError:
            raise CollectError("缺少纯 Python 签名依赖 xhshow。") from None
        self.signer = Xhshow()
        self.search_ids = {}

    def post(self, path, payload):
        headers = self.signer.sign_headers_post(
            uri=path, cookies=self.session.cookies, payload=payload, x_rap=True
        )
        headers.update(
            {
                "Origin": "https://www.xiaohongshu.com",
                "Referer": "https://www.xiaohongshu.com/",
                "Content-Type": "application/json;charset=UTF-8",
            }
        )
        d = self.session.json(
            "POST",
            "https://edith.xiaohongshu.com" + path,
            data=json.dumps(
                payload, separators=(",", ":"), ensure_ascii=False
            ).encode(),
            headers=headers,
        )
        if not d.get("success"):
            code = d.get("code")
            raise CollectError(
                f"小红书接口返回代码 {code}，未将其当作空列表。",
                "blocked" if code in (-100, -101, -104, 300011, 300012) else "failed",
            )
        return d.get("data", {})

    def page(self, tag, kind, cursor):
        p = int(cursor or 1)
        search_id = self.search_ids.setdefault(tag, self.signer.get_search_id())
        d = self.post(
            "/api/sns/web/v1/search/notes",
            {
                "keyword": "#" + tag,
                "page": p,
                "page_size": 20,
                "search_id": search_id,
                "sort": "time_descending",
                "note_type": 0,
            },
        )
        rows = d.get("items")
        if not isinstance(rows, list):
            if d.get("has_more") is False:
                rows = []
            else:
                raise CollectError("小红书没有返回可识别的作品列表。")
        items = [
            {"id": row["id"], "xsec_token": row.get("xsec_token", "")}
            for row in rows
            if row.get("id") and row.get("model_type", "note") == "note"
        ]
        if not items and d.get("has_more"):
            raise CollectError(
                "小红书列表为空但声称仍有下一页，不能标为取完。", "blocked"
            )
        return Page(items, p + 1, d.get("has_more") is False)

    def detail(self, item, kind):
        d = self.post(
            "/api/sns/web/v1/feed",
            {
                "source_note_id": item["id"],
                "image_formats": ["jpg", "webp", "avif"],
                "extra": {"need_body_topic": 1},
                "xsec_source": "pc_search",
                "xsec_token": item.get("xsec_token", ""),
            },
        )
        items = d.get("items", [])
        if not items or not isinstance(items[0].get("note_card"), dict):
            raise CollectError("小红书作品详情为空。")
        b = items[0]["note_card"]
        stat = b.get("interact_info", {})
        return self.observation(
            item["id"],
            b.get("title"),
            f'https://www.xiaohongshu.com/explore/{item["id"]}',
            b.get("time"),
            stat.get("liked_count"),
            None,
            [t.get("name", "") for t in b.get("tag_list", [])],
            {
                "likedCount": stat.get("liked_count"),
                "collectedCount": stat.get("collected_count"),
            },
        )
