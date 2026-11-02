"""旧 LOFTER 逐作品适配器，已停用；当前入口使用 lofter_tags.py。"""

from __future__ import annotations

import re
import threading
import time

from collector_sources.base import Page, Source
from tag_session import CollectError, exact_count


class Lofter(Source):
    platform = "lofter"
    kinds = ("works",)
    user_agent = "LOFTER-Android 7.9.7.2 (PCT-AL10; Android 10; null) MOBILE"
    endpoint = "https://api.lofter.com/newapi/tagPosts.json"

    def __init__(self, interval=3.5):
        super().__init__(interval)
        self.interval = max(1.0, interval)
        self.request_lock = threading.Lock()
        self.local = threading.local()
        self.last_request = 0.0
        self.requests = 0
        self.cancelled = lambda: False

    def post(self, url, data=None):
        # 多线程共用节奏，不能把 3 个线程各等 3 秒误当成全局 3 秒一请求。
        with self.request_lock:
            while True:
                if self.cancelled():
                    raise CollectError("已请求停止，保留当前页断点。", "cancelled")
                wait = self.interval - (time.monotonic() - self.last_request)
                if wait <= 0:
                    break
                time.sleep(min(wait, 0.2))
            self.last_request = time.monotonic()
            self.requests += 1
            response = self.session.request(
                "POST", url, data=data, headers={"User-Agent": self.user_agent},
                allow_redirects=False,
            )
        if 300 <= response.status_code < 400:
            response.close()
            raise CollectError("LOFTER 返回重定向，可能需要登录或正在限流；未当作空标签。", "blocked")
        return response

    def page(self, tag, kind="works", cursor=None):
        if not getattr(self.local, "ready", False):
            self.post("https://api.lofter.com/v1.1/newTag.api").close()
            self.local.ready = True
        cursor = cursor or {"offset": 0, "anchor": None}
        offset = exact_count(cursor.get("offset"))
        if offset is None:
            raise CollectError("LOFTER 分页断点的 offset 无效。")
        response = self.post(
            self.endpoint,
            {
                "product": "lofter-android-7.9.7.2", "postTypes": "",
                "offset": str(offset), "postYm": "", "recentDay": "0",
                "protectedFlag": "0", "range": "0", "style": "0",
                "firstpermalink": cursor.get("anchor") or "null",
                "tag": tag, "type": "new",
            },
        )
        try:
            body = response.json()
        except ValueError:
            raise CollectError("LOFTER 没有返回 JSON，可能是登录页或验证页；未当作空结果。", "blocked") from None
        finally:
            response.close()
        if not isinstance(body, dict) or type(body.get("code")) is not int or body["code"] != 0:
            raise CollectError("LOFTER 标签接口拒绝读取，未推进断点。", "blocked")
        data = body.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("list"), list):
            raise CollectError("LOFTER 未返回可识别的作品列表，不能记为无作品。", "blocked")
        rows = data["list"]
        raw_offset = data.get("offset")
        ended = type(raw_offset) is int and raw_offset == -1
        next_offset = offset if ended else exact_count(raw_offset)
        if next_offset is None:
            raise CollectError("LOFTER 未返回有效的下一页偏移量。")
        if not ended and (not rows or next_offset <= offset):
            raise CollectError("LOFTER 分页游标没有前进，不能标为已取完。", "restricted")
        items = []
        for row in rows:
            post, _ = self.parts(row)
            native_id = exact_count(post.get("id"))
            if native_id is None:
                raise CollectError("LOFTER 返回没有原生作品 ID 的条目，未跳过该页。")
            items.append({"id": str(native_id), "row": row})
        anchor = cursor.get("anchor")
        if items and not anchor:
            anchor = self.parts(items[0]["row"])[0].get("permalink")
        if anchor is not None and (not isinstance(anchor, str) or not re.fullmatch(r"[\w-]+", anchor)):
            raise CollectError("LOFTER 原生分页锚点格式无效。")
        # 原生 offset=-1 才是结束；最后一页可以仍带作品，不能先丢掉它。
        return Page(items, {"offset": next_offset, "anchor": anchor}, ended)

    @staticmethod
    def parts(row):
        data = row.get("postData") if isinstance(row, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("postView"), dict):
            raise CollectError("LOFTER 作品结构不可识别，未将异常条目静默丢弃。")
        counts = data.get("postCount")
        return data["postView"], counts if isinstance(counts, dict) else {}

    def row_work(self, item, kind="works"):
        row = item["row"]
        post, counts = self.parts(row)
        tags = post.get("tagList")
        if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
            raise CollectError("LOFTER 未提供原生标签列表，不能仅凭搜索词归属作品。")
        blog = (row.get("blogInfo") or {}).get("blogName")
        permalink = post.get("permalink")
        if not isinstance(blog, str) or not re.fullmatch(r"[a-zA-Z0-9-]+", blog):
            raise CollectError("LOFTER 未提供可核验的作品来源域名。")
        if not isinstance(permalink, str) or not re.fullmatch(r"[\w-]+", permalink):
            raise CollectError("LOFTER 未提供可核验的作品来源路径。")
        published = post.get("publishTime")
        if exact_count(published) is None or not published:
            raise CollectError("LOFTER 缺少原始发布时间。")
        likes = exact_count(counts.get("favoriteCount"))
        native = {k: counts[k] for k in (
            "favoriteCount", "viewCount", "responseCount", "reblogCount",
            "shareCount", "hotCount", "subscribeCount",
        ) if k in counts}
        missing = {
            "views": "标签接口的 viewCount 公开浏览量口径尚未核验；原值另存，不作为精确观看量统计。",
        }
        if likes is None:
            missing["likes"] = "标签接口未提供精确整数 favoriteCount；未用 hotCount、收藏或推荐替代。"
        raw_type = post.get("type")
        work = self.observation(
            item["id"], post.get("title"),
            f"https://{blog}.lofter.com/post/{permalink}",
            published, likes, None, tags, native,
            type={1: "文字", 2: "图文"}.get(raw_type, f"原生类型 {raw_type}"),
            missing=missing,
        )
        work["nativeType"] = raw_type
        work["metricFields"] = {"likes": "postData.postCount.favoriteCount", "views": None}
        return work

    def detail(self, item, kind="works"):
        return self.row_work(item, kind)
