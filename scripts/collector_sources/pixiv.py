"""pixiv 平台独立 HTTP 适配器。"""

from __future__ import annotations
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from tag_session import CollectError, exact_count
from collector_sources.base import Source, Page


class Pixiv(Source):
    """Pixiv 标签检索：插画、漫画、动图与小说。

    登录并开启 R-18 显示后，接口不再钳制页数：lastPage 与 total 一致，
    顺序翻页就能取完，且 mode=all 已经把 R-18 一并返回，不必另开一路。
    匿名会话只放行 10 页 × 60 = 600 件，第 11 页起被钳制成第 10 页的内容，
    返回的 lastPage 也恒为 10，两者都不可信；这时退回按 scd／ecd 时间窗
    递归二分，直到单窗 total ≤ 600，切到单日仍超过才如实标记截断。

    统一用 order=date 升序：新发表的作品只追加到末尾，不会把已经翻过的页
    往后挤，跨小时的长采集不会因为列表位移而漏件。

    检索行本身已带完整原生标签、发布时间、分级与作品类型，归属判定不必
    再逐件请求详情；点赞与播放只有详情接口才给，留到指标阶段按断点补齐，
    缺失就是缺失，不写成 0。两类每页条数不同（插画 60、小说 30），
    页数上限也从匿名的 10 页放宽到登录后的 1000 页。
    """

    platform = "pixiv"
    kinds = ("artworks", "novels")
    deferred_metrics = True
    page_sizes = {"artworks": 60, "novels": 30}
    cap_pages = 1000
    epoch = "2007-01-01"
    order = "date"
    # 分辨"限流"与"标签真的没作品"用的对照标签：必然有大量作品。
    control_tag = "アークナイツ"
    illust_types = {0: "插画", 1: "漫画", 2: "动图"}
    ratings = {0: "全年龄", 1: "R-18", 2: "R-18G"}
    jst = timezone(timedelta(hours=9))

    def page_size(self, kind):
        return self.page_sizes.get(kind, 60)

    @property
    def cap(self):
        return self.page_sizes["artworks"] * self.cap_pages

    # 空壳响应重试：5s → 20s → 60s，仍是空壳就如实报封锁，不当作没有作品。
    empty_backoff = (5.0, 20.0, 60.0)

    def search(self, tag, kind, p, lo=None, hi=None):
        params = {
            "word": tag,
            "s_mode": "s_tag_full",
            "order": self.order,
            "p": p,
            "mode": "all",
            "lang": "zh",
        }
        if lo:
            params["scd"] = lo
            params["ecd"] = hi
        quoted = quote(tag, safe="")
        url = f"https://www.pixiv.net/ajax/search/{kind}/{quoted}"
        headers = {"Referer": f"https://www.pixiv.net/tags/{quoted}/art"}
        key = "illustManga" if kind == "artworks" else "novel"
        for attempt in range(len(self.empty_backoff) + 1):
            result = self.session.json("GET", url, params=params, headers=headers)
            if result.get("error"):
                raise CollectError("Pixiv 标签接口拒绝读取，未当作无作品。", "blocked")
            body = result.get("body")
            section = body.get(key) if isinstance(body, dict) else None
            if not isinstance(section, dict) or not isinstance(section.get("data"), list):
                raise CollectError("Pixiv 分页结构不可识别。")
            if section.get("data") or not self.suspicious_empty(section, p, bool(lo)):
                return section
            if not self.control_is_empty():
                # 对照标签有作品，说明会话正常，是这个标签自己确实没有作品。
                return section
            if attempt == len(self.empty_backoff):
                break
            self.session.penalty(self.empty_backoff[attempt])
        raise CollectError(
            "Pixiv 连续返回空壳响应（对照标签同样为空），判定为限流；"
            "已保存断点，不当作该标签没有作品。",
            "blocked",
        )

    @staticmethod
    def suspicious_empty(section, p, windowed):
        """结构上像限流：作品列表为空，但接口自称还有作品或这是第一页。

        相关标签与标签翻译来自标签图谱，不是检索结果——零作品的标签照样
        返回二十条相关标签，所以它们不能当旁证（先前正是这么把空标签
        误判成限流，还为此冻结了全部线程）。这里只做结构判断，
        真正的分辨交给 control_is_empty 的一次对照请求。
        加了 scd／ecd 之后某个窗口本来就可能没有作品；翻过第一页后，
        只有还落在接口自报页数范围内的空页才算异常。
        """
        total = exact_count(section.get("total")) or 0
        last = exact_count(section.get("lastPage")) or 0
        if total:
            return p == 1 or not last or p < last
        return p == 1 and not windowed

    def control_is_empty(self):
        """对照请求：拿一个必然有大量作品的大标签去问。

        它也空，才是会话被限流；它有作品，就是刚才那个标签真的没作品。
        对照请求自己失败时按限流处理，宁可多等一轮也不把空标签当结论。
        """
        quoted = quote(self.control_tag, safe="")
        try:
            result = self.session.json(
                "GET",
                f"https://www.pixiv.net/ajax/search/artworks/{quoted}",
                params={
                    "word": self.control_tag,
                    "s_mode": "s_tag_full",
                    "order": self.order,
                    "p": 1,
                    "mode": "all",
                    "lang": "zh",
                },
                headers={"Referer": f"https://www.pixiv.net/tags/{quoted}/art"},
            )
        except CollectError:
            return True
        section = (result.get("body") or {}).get("illustManga")
        return not (isinstance(section, dict) and section.get("data"))

    @staticmethod
    def rows(body):
        return [{"id": str(row["id"]), "row": row} for row in body["data"] if row.get("id")]

    def page(self, tag, kind, cursor):
        # 旧断点存的是页码整数或没有时间窗字段的游标，与现在不兼容，从头开始。
        if not isinstance(cursor, dict) or "mode" not in cursor:
            return self.open(tag, kind)
        if cursor["mode"] == "pages":
            return self.page_direct(tag, kind, cursor)
        return self.page_windows(tag, kind, cursor)

    def clamped(self, total, last, kind):
        """接口自报页数装不下它自报的总量，就是被钳制了。

        登录后插画仍停在 1000 页上限：41 万件的标签只给到 6 万件，
        lastPage × 每页条数 < total 就是证据，不能当成翻到底。
        """
        return bool(total) and last * self.page_size(kind) < total

    def open(self, tag, kind):
        """第一次请求先探明当前会话能不能直接翻到底，再决定用哪种游标。"""
        body = self.search(tag, kind, 1)
        items = self.rows(body)
        total = exact_count(body.get("total")) or 0
        last = exact_count(body.get("lastPage")) or 0
        if not self.clamped(total, last, kind):
            done = not items or last <= 1
            return Page(
                items,
                {"mode": "pages", "page": 2, "got": len(items), "total": total},
                done,
                total,
                done and len(items) < total,
            )
        # 会话能翻到的页数装不下总量：转时间窗二分，本次探测请求不计入任何窗口。
        return self.page_windows(
            tag,
            kind,
            {
                "mode": "windows",
                "windows": [
                    [self.epoch, (date.today() + timedelta(days=1)).isoformat()]
                ],
                "page": 1,
                "got": 0,
                "restricted": False,
            },
        )

    def page_direct(self, tag, kind, cursor):
        p = int(cursor["page"])
        got = int(cursor.get("got") or 0)
        body = self.search(tag, kind, p)
        items = self.rows(body)
        total = exact_count(body.get("total")) or int(cursor.get("total") or 0)
        last = exact_count(body.get("lastPage")) or 0
        got += len(items)
        done = not items or (last and p >= last)
        return Page(
            items,
            {"mode": "pages", "page": p + 1, "got": got, "total": total},
            done,
            total,
            # 取到接口说结束为止仍少于它自己报的总量，就是被截断，不能标已取完。
            done and got < total,
        )

    def page_windows(self, tag, kind, cursor):
        windows = [list(w) for w in cursor["windows"]]
        p = int(cursor.get("page") or 1)
        got = int(cursor.get("got") or 0)
        restricted = bool(cursor.get("restricted"))
        while windows:
            lo, hi = windows[0]
            start, end = date.fromisoformat(lo), date.fromisoformat(hi)
            body = self.search(tag, kind, p, lo, hi)
            rows = [row for row in body["data"] if row.get("id")]
            total = exact_count(body.get("total")) or 0
            if p == 1 and self.clamped(total, exact_count(body.get("lastPage")) or 0, kind):
                if start < end:
                    mid = start + (end - start) // 2
                    windows[:1] = [
                        [start.isoformat(), mid.isoformat()],
                        [(mid + timedelta(days=1)).isoformat(), end.isoformat()],
                    ]
                    continue
                # 已经是单日窗口仍装不下；接口不支持更细的时间粒度。
                restricted = True
            self.check_window(rows, start, end)
            items = [{"id": str(row["id"]), "row": row} for row in rows]
            got += len(items)
            last_page = exact_count(body.get("lastPage"))
            finished = not items or (last_page is not None and p >= last_page)
            if finished:
                if got < total:
                    restricted = True
                windows.pop(0)
                p, got = 1, 0
            else:
                p += 1
            if items or not windows:
                return Page(
                    items,
                    {
                        "mode": "windows",
                        "windows": windows,
                        "page": p,
                        "got": got,
                        "restricted": restricted,
                    },
                    not windows,
                    None,
                    restricted,
                )
        return Page([], None, True, None, restricted)

    def check_window(self, rows, start, end):
        """时间筛选必须真的生效，否则分段是假的，截断会被当成已取完。

        createDate 带 +09:00 偏移，按日本时区的日期与窗口比对。
        """
        for row in rows:
            created = row.get("createDate")
            if not created:
                continue
            try:
                day = datetime.fromisoformat(created).astimezone(self.jst).date()
            except ValueError:
                continue
            if not start <= day <= end:
                raise CollectError(
                    "Pixiv 时间筛选未按预期生效，不能把截断列表标为取完。"
                )

    def row_work(self, item, kind):
        """用检索行直接落库：归属、发布时间、分级、类型都齐了，不发详情请求。

        点赞与播放只有详情接口给，这里一律留空并写明原因，由指标阶段补齐。
        一页 60 件（小说 30 件）只花一个请求，长采集才追得完全量。
        """
        row = item.get("row")
        if not isinstance(row, dict) or not row.get("id"):
            return None
        novel = kind == "novels"
        id = str(row["id"])
        work = self.observation(
            ("novel:" if novel else "") + id,
            row.get("title"),
            (
                f"https://www.pixiv.net/novel/show.php?id={id}"
                if novel
                else f"https://www.pixiv.net/artworks/{id}"
            ),
            row.get("createDate"),
            None,
            None,
            row.get("tags") or [],
            {
                "xRestrict": row.get("xRestrict"),
                "bookmarkCount": row.get("bookmarkCount"),
                "wordCount": row.get("wordCount"),
                "aiType": row.get("aiType"),
                "pageCount": row.get("pageCount"),
            },
            type=(
                "小说"
                if novel
                else self.illust_types.get(row.get("illustType"), "插画")
            ),
            missing={
                metric: "点赞与播放只有作品详情接口返回，留待指标阶段按断点补齐。"
                for metric in ("likes", "views")
            },
        )
        work["rating"] = self.ratings.get(row.get("xRestrict"), "未标注")
        return work

    def detail(self, item, kind):
        id = item["id"]
        novel = kind == "novels"
        result = self.session.json(
            "GET",
            f'https://www.pixiv.net/ajax/{"novel" if novel else "illust"}/{id}',
            headers={"Referer": "https://www.pixiv.net/"},
        )
        if result.get("error") or not isinstance(result.get("body"), dict):
            raise CollectError("Pixiv 作品详情不可读取。")
        b = result["body"]
        # 收藏数与评论数只作为原生指标另存，不冒充点赞或播放。
        work = self.observation(
            ("novel:" if novel else "") + id,
            b.get("title") or b.get("illustTitle"),
            (
                f"https://www.pixiv.net/novel/show.php?id={id}"
                if novel
                else f"https://www.pixiv.net/artworks/{id}"
            ),
            b.get("createDate"),
            b.get("likeCount"),
            b.get("viewCount"),
            [t.get("tag", "") for t in ((b.get("tags") or {}).get("tags") or [])],
            {
                "likeCount": b.get("likeCount"),
                "viewCount": b.get("viewCount"),
                "bookmarkCount": b.get("bookmarkCount"),
                "commentCount": b.get("commentCount"),
                "xRestrict": b.get("xRestrict"),
            },
            type="小说" if novel else self.illust_types.get(b.get("illustType"), "插画"),
        )
        # 分级照实记；接口没给就写未标注，不按"大概是全年龄"猜。
        work["rating"] = self.ratings.get(b.get("xRestrict"), "未标注")
        return work
