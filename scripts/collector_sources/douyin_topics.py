"""抖音创作平台话题建议汇总；纯 HTTP，不访问搜索页面或作品列表。"""

from __future__ import annotations

import math
import re
from urllib.parse import urlencode

from collector_sources.base import now
from tag_session import CollectError, Session, exact_count


ENDPOINT = "https://creator.douyin.com/aweme/v1/search/challengesug/"


def parse_topics(payload, tag):
    if not isinstance(payload, dict) or type(payload.get("status_code")) is not int:
        raise CollectError("抖音话题接口缺少原生状态，未把异常响应当作零。")
    if payload["status_code"] != 0:
        raise CollectError("抖音话题接口未通过会话或业务校验，已停止试采。", "blocked")
    rows = payload.get("sug_list")
    if not isinstance(rows, list):
        raise CollectError("抖音话题接口缺少建议列表，未推断为零。")
    topics = []
    seen = {}
    for row in rows:
        if not isinstance(row, dict):
            raise CollectError("抖音话题列表结构不可识别。")
        name, cid = row.get("cha_name"), row.get("cid")
        if type(cid) is int and cid > 0:
            cid = str(cid)
        if not isinstance(name, str) or not name or not isinstance(cid, str) or not re.fullmatch(r"[0-9]+", cid):
            raise CollectError("抖音话题缺少有效名称或 ID，未猜测对应关系。")
        native_count = row.get("view_count")
        count = exact_count(native_count)
        if native_count is not None and count is None:
            raise CollectError("抖音话题原生播放量格式异常，未写成零。")
        topic = {"tag": name, "topicId": cid, "playCount": count, "native": {"view_count": native_count}}
        if cid in seen:
            if seen[cid] != topic:
                raise CollectError("同一话题 ID 返回了冲突的数据，未选择较大值。")
            continue
        seen[cid] = topic
        topics.append(topic)
    matches = [topic for topic in topics if topic["tag"] == tag]
    if len(matches) > 1:
        raise CollectError("同名话题存在多个 ID，需核实归属，未自动合并。")
    matched = matches[0] if matches else None
    return {
        "status": "ok" if matched and matched["playCount"] is not None else "partial" if matched else "unavailable",
        "topicId": matched["topicId"] if matched else None,
        "playCount": matched["playCount"] if matched else None,
        "native": matched["native"] if matched else {"view_count": None},
        "missingReason": None if matched and matched["playCount"] is not None else "精确同名话题的播放量未返回；不代表话题不存在或播放量为零。",
        "returnedTopics": topics,
        "association": "exact_topic_name_only_operator_identity_unverified",
        "coverage": "接口只返回固定数量的话题建议，不代表全部匹配话题。",
    }


class DouyinTopics:
    def __init__(self, interval=3.5):
        if not math.isfinite(interval) or interval < 3.5:
            raise CollectError("抖音试采请求间隔至少为3.5秒。")
        self.session = Session("douyin", interval, retries=1)
        self.requests = 0
        self.cancelled = lambda: False

    def read(self, tag):
        tag = tag.strip().removeprefix("#").strip()
        if not tag or any(ord(char) < 32 for char in tag):
            raise CollectError("请提供有效话题名称。")
        if self.cancelled():
            raise CollectError("已请求保存停止。", "cancelled")
        params = {"keyword": tag, "source": "challenge_create", "aid": "2906"}
        self.requests += 1
        response = self.session.request(
            "GET", ENDPOINT, params=params, allow_redirects=False,
            headers={"Referer": "https://creator.douyin.com/creator-micro/content/upload", "Accept": "application/json, text/plain, */*"},
        )
        try:
            if 300 <= response.status_code < 400:
                raise CollectError("话题接口返回重定向，需检查登录或验证状态。", "blocked")
            try:
                payload = response.json()
            except ValueError:
                body = response.content.decode("utf-8", errors="replace")
                if re.search(r"验证码|captcha|verifycenter", body, re.I):
                    raise CollectError("话题接口返回验证码，已停止试采。", "blocked") from None
                raise CollectError("话题接口返回空响应或非JSON内容，未把它当作空列表。") from None
        finally:
            response.close()
        result = parse_topics(payload, tag)
        return {
            "platform": "douyin", "kind": "topic_summary", "tag": tag,
            "sourceUrl": ENDPOINT + "?" + urlencode(params),
            "observedAt": now(), "publishedAt": None,
            "timeBasis": "all_time_at_observation", "aggregation": "per_topic_do_not_sum",
            "metric": "native_view_count", "workCount": None,
            **result,
        }
