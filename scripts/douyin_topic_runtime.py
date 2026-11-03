"""抖音中文话题汇总的独立断点、事务存储与本地快照。"""

import json
from pathlib import Path
from types import SimpleNamespace

from collector_sources.douyin_topics import DouyinTopics
from collector_sources.base import now
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import CollectError, LOCAL
from tag_store import atomic_json


RUNTIME = LOCAL / "douyin"
AMIYA_FORM_IDS = {"char_002_amiya", "char_1001_amiya2", "char_1037_amiya3"}


def primary_topic_name(operator):
    # 仅为已确认的同一人物建立映射，不泛化删除其他干员名称中的括号。
    return "阿米娅" if operator["id"] in AMIYA_FORM_IDS else operator["name"]


def make_topic_plan(operators):
    plan = {}
    for operator in operators:
        name = primary_topic_name(operator)
        item = plan.setdefault(name, {"key": name, "tag": name, "operatorIds": [], "scope": "exact_chinese_primary_topic"})
        item["operatorIds"] = sorted(set(item["operatorIds"]) | {operator["id"]})
    # 已验证的样例优先，便于启动后立即确认接口状态；其余仍全部处理。
    return sorted(plan.values(), key=lambda item: item["tag"] != "阿尔图罗")


class DouyinTopicStore(TagStatsStore):
    def __init__(self, directory=LOCAL):
        super().__init__(directory, platform="douyin")

    def completed_state(self, record):
        return "completed" if record.get("status") == "ok" and record.get("playCount") is not None else "unavailable"


class DouyinTopicCollector(TagStatsCollector):
    kind = "douyin_topic_summary"
    label = "抖音"

    def __init__(self, operators, *, interval=3.5, resume=True, store=None, source=None, runtime=RUNTIME):
        super().__init__(
            operators, workers=1, interval=interval, resume=resume, primary_only=True,
            store=store if store is not None else DouyinTopicStore(),
            source=source if source is not None else DouyinTopics(interval), runtime=runtime,
            plan=make_topic_plan(operators),
        )

    def publish(self):
        super().publish()
        signature = (self.job["state"], self.job["requests"], self.job["processedTags"], self.job["lastObservation"])
        if signature == getattr(self, "_exported_signature", None):
            return
        with self.store.lock:
            records = [json.loads(row[0]) for row in self.store.db.execute(
                "SELECT data FROM douyin_tag_history WHERE run_id=? ORDER BY tag_key", (self.job["id"],))]
        atomic_json(self.runtime / "topic-counts.json", {
            "metadata": {
                "platform": "douyin", "runId": self.job["id"], "state": self.job["state"],
                "totalOperators": self.job["totalOperators"], "totalTags": self.job["totalTags"],
                "processedTags": self.job["processedTags"], "readableTags": self.job["completedTags"],
                "unavailableTags": self.job["unavailableTags"],
                "metric": "native_view_count", "association": "exact_topic_name_only_operator_identity_unverified",
                "coverage": "中文主标签的固定数量建议接口；同名话题归属未核实，不代表角色专属或全站作品总量。",
            },
            "records": records,
        })
        if self.store.directory == LOCAL and self.runtime == RUNTIME:
            from douyin_topic_export import export_counts
            export_counts()
        self._exported_signature = signature


def reconcile_topic_mapping(operators, store, runtime=RUNTIME):
    """离线建立修正后的批次；保留旧历史，沿用真实原始值和采集时间。"""
    runtime = Path(runtime)
    try:
        old_job = json.loads((runtime / "http-job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise CollectError("没有可整理的抖音采集批次。") from None
    if old_job.get("kind") != "douyin_topic_summary" or old_job.get("state") == "running":
        raise CollectError("请在抖音任务结束或保存停止后整理标签映射。")
    with store.lock:
        old_rows = {tag: json.loads(data) for tag, data in store.db.execute(
            "SELECT tag_key,data FROM douyin_tag_history WHERE run_id=?", (old_job["id"],))}
        old_faults = {tag: (state, note) for tag, state, note in store.db.execute(
            "SELECT tag_key,state,note FROM douyin_tag_queue WHERE run_id=?", (old_job["id"],))}
    # 此处只整理已保存数据，不创建 HTTP Session，也不发起网络请求。
    collector = DouyinTopicCollector(operators, store=store, source=SimpleNamespace(requests=0), runtime=runtime, resume=False)
    reused = 0
    for item in collector.plan:
        row = old_rows.get(item["tag"])
        if row is not None and row.get("tag") == item["tag"]:
            observation = {**row, "reusedFromRun": old_job["id"]}
            collector.store.put(collector.job["id"], item, observation)
            reused += 1
            if item["tag"] == "阿米娅":
                collector.job["lastObservation"] = {**observation, "operatorIds": item["operatorIds"]}
        else:
            old_state, note = old_faults.get(item["tag"], ("pending", "尚未取得该话题数据。"))
            state = old_state if old_state in ("failed", "blocked", "pending", "cancelled") else "pending"
            collector.store.fail(collector.job["id"], item["key"], state, note)
            collector.job["errors"].append(f"#{item['tag']}：{note}")
    collector.job.update(collector.store.coverage(collector.job["id"], collector.plan))
    collector.job.update({"sourceRunId": old_job["id"], "reusedTags": reused, "finishedAt": now(), "current": ""})
    collector.job["state"] = "failed" if collector.job["processedTags"] < len(collector.plan) else "partial" if collector.job["unavailableTags"] else "completed"
    collector.publish()
    return collector.job
