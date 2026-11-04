"""小红书角色话题的原生浏览量。"""

import re

from collector_sources.base import now
from collector_sources.xiaohongshu import Xiaohongshu
from tag_session import CollectError, exact_count


TOPIC_ENDPOINT = "/web_api/sns/v1/search/topic"


class XiaohongshuTopics(Xiaohongshu):
    def __init__(self, interval=3.5):
        super().__init__(interval)
        self.requests = 0

    def read(self, tag):
        self.requests += 1
        data = self.post(TOPIC_ENDPOINT, {
            "keyword": tag,
            "suggest_topic_request": {"title": "", "desc": ""},
            "page": {"page_size": 20, "page": 1},
        })
        rows = data.get("topic_info_dtos") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise CollectError("小红书未返回可识别的话题候选列表。")

        matches = {}
        for row in rows:
            if not isinstance(row, dict) or row.get("name") != tag:
                continue
            topic_id = row.get("id")
            if not isinstance(topic_id, str) or not re.fullmatch(r"[0-9a-f]{24}", topic_id):
                raise CollectError("小红书精确匹配的话题缺少有效 ID。")
            count = exact_count(row.get("view_num"))
            if topic_id in matches and matches[topic_id] != count:
                raise CollectError("同一小红书话题返回了互相矛盾的浏览量。")
            matches[topic_id] = count

        topic_id, count = next(iter(matches.items())) if len(matches) == 1 else (None, None)
        reason = None
        if not matches:
            reason = "候选中没有精确匹配的话题。"
        elif len(matches) > 1:
            reason = "出现同名的多个话题 ID，归属待核对。"
        elif count is None:
            reason = "话题未返回有效的原生浏览量。"

        return {
            "platform": self.platform,
            "kind": "topic_summary",
            "tag": tag,
            "topicId": topic_id,
            "url": f"https://www.xiaohongshu.com/page/topics/{topic_id}" if topic_id else None,
            "sourceEndpoint": "https://edith.xiaohongshu.com" + TOPIC_ENDPOINT,
            "nativeMetrics": {"view_num": count},
            "status": "unavailable" if reason else "ok",
            "missingReason": reason,
            "publishedAt": None,
            "observedAt": now(),
        }
