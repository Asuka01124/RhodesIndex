"""纯 HTTP 平台适配器的公共类型与时间格式。"""

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from tag_session import Session, CollectError, exact_count


def now():
    return datetime.now(timezone.utc).isoformat()


def date_value(value):
    if type(value) in (int, float) and value > 0:
        return datetime.fromtimestamp(
            value / 1000 if value > 1e12 else value, timezone.utc
        ).isoformat()
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.isoformat()
        except ValueError:
            pass
    raise CollectError("缺少可核验的原始发布时间。")


@dataclass
class Page:
    items: list
    cursor: object
    done: bool
    advertised: int | None = None
    restricted: bool = False


class Source:
    platform = ""
    kinds = ("works",)
    # 翻页时拿不到点赞、只能事后逐件补的平台才置 True；
    # 本来就不提供点赞的平台不要进队列，否则永远补不完还算成缺失。
    deferred_metrics = False

    def __init__(self, interval=0.7):
        self.session = Session(self.platform, interval)

    def page(self, tag, kind, cursor):
        raise NotImplementedError

    def detail(self, item, kind):
        raise NotImplementedError

    def row_work(self, item, kind):
        """检索行自带足够信息时直接落库；返回 None 表示仍需逐件请求详情。"""
        return None

    def observation(
        self,
        id,
        title,
        url,
        published,
        likes,
        views,
        tags,
        native,
        type="作品",
        missing=None,
        basis="exact_tag",
    ):
        if not isinstance(url, str) or not url.startswith("https://"):
            raise CollectError("作品来源未返回有效 HTTPS 链接。")
        # 真实的 0 必须保留为 0；None 才是缺失，缺失要写清原因。
        absent = dict(missing or {})
        for metric, value in (("likes", likes), ("views", views)):
            if exact_count(value) is None and metric not in absent:
                absent[metric] = "该平台未提供此项指标。"
        return dict(
            id=str(id),
            platform=self.platform,
            type=type,
            title=title or "未命名作品",
            url=url,
            publishedAt=date_value(published),
            likes=exact_count(likes),
            views=exact_count(views),
            tags=list(dict.fromkeys(t for t in tags if t)),
            operatorIds=[],
            matchBasis=basis,
            missing=absent,
            nativeMetrics={k: exact_count(v) for k, v in native.items()},
            observedAt=now(),
        )
