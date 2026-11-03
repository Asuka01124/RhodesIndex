"""bilibili 平台独立 HTTP 适配器。"""

from __future__ import annotations
import time
from tag_session import CollectError
from collector_sources.base import Source, Page


class Bilibili(Source):
    platform = "bilibili"

    def page(self, tag, kind, cursor):
        state = cursor or {
            "windows": [[1, int(time.time())]],
            "page": 1,
            "restricted": False,
        }
        windows = [list(w) for w in state["windows"]]
        p = state["page"]
        restricted = state.get("restricted", False)
        while windows:
            lo, hi = windows[0]
            d = self.session.json(
                "GET",
                "https://api.bilibili.com/x/web-interface/search/type",
                params={
                    "search_type": "video",
                    "keyword": "#" + tag + "#",
                    "page": p,
                    "page_size": 50,
                    "pubtime_begin_s": lo,
                    "pubtime_end_s": hi,
                    "order": "pubdate",
                },
                headers={"Referer": "https://www.bilibili.com/"},
            )
            if d.get("code") != 0:
                raise CollectError(
                    f'B站搜索接口受限（代码 {d.get("code")}）。', "blocked"
                )
            b = d.get("data", {})
            rows = b.get("result")
            if rows is None and b.get("numResults") == 0:
                rows = []
            if not isinstance(rows, list):
                raise CollectError("B站搜索分页结构不可识别。")
            total = int(b.get("numResults") or 0)
            if p == 1 and total >= 1000 and hi - lo > 1:
                mid = (lo + hi) // 2
                windows[:1] = [[lo, mid], [mid + 1, hi]]
                continue
            if any(
                row.get("pubdate") and not lo <= row["pubdate"] <= hi for row in rows
            ):
                raise CollectError("B站时间筛选未按预期生效，不能把截断列表标为取完。")
            if total >= 1000:
                restricted = True
            items = [{"id": row["bvid"]} for row in rows if row.get("bvid")]
            last = not items or p >= int(b.get("numPages") or 1)
            if last:
                windows.pop(0)
                p = 1
            else:
                p += 1
            if items or not windows:
                return Page(
                    items,
                    {"windows": windows, "page": p, "restricted": restricted},
                    not windows,
                    None,
                    restricted,
                )
        return Page([], None, True, None, restricted)

    def detail(self, item, kind):
        id = item["id"]
        result = self.session.json(
            "GET",
            "https://api.bilibili.com/x/web-interface/view/detail",
            params={"bvid": id},
            headers={"Referer": "https://www.bilibili.com/"},
        )
        if result.get("code") in (-101, -111, -352, -412, -509, -799):
            raise CollectError("B站详情或标签接口出现登录、验证或频率限制，已保存停止。", "blocked")
        data = result.get("data")
        if result.get("code") != 0 or not isinstance(data, dict):
            raise CollectError("B站作品详情或原生 TAG 不可读取。")
        b, tags = data.get("View"), data.get("Tags")
        if not isinstance(b, dict) or b.get("bvid") != id or not isinstance(tags, list):
            raise CollectError("B站合并详情未返回对应作品或有效原生 TAG，未把缺失当成空标签。")
        if any(not isinstance(t, dict) or not isinstance(t.get("tag_name"), str) for t in tags):
            raise CollectError("B站合并详情的原生 TAG 结构不可识别。")
        stat = b.get("stat", {})
        return self.observation(
            id,
            b.get("title"),
            f"https://www.bilibili.com/video/{id}/",
            b.get("pubdate"),
            stat.get("like"),
            stat.get("view"),
            [t["tag_name"] for t in tags],
            {
                "like": stat.get("like"),
                "view": stat.get("view"),
                "favorite": stat.get("favorite"),
            },
        )
