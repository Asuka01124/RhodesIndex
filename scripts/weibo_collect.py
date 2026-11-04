"""微博干员话题原创人数、讨论次数与阅读次数采集。"""

import argparse
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from collector_sources.weibo_topics import WeiboTopics
from character_topic_rules import make_character_topic_plan as make_weibo_plan
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import CollectError, LOCAL
from tag_store import atomic_json


RUNTIME = LOCAL / "weibo"


@contextmanager
def run_lock():
    import msvcrt

    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / "http-run.lock").open("a+b") as file:
        if not file.tell():
            file.write(b"1")
            file.flush()
        file.seek(0)
        try:
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CollectError("已有微博采集任务运行。") from None
        try:
            yield
        finally:
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


class WeiboTopicCollector(TagStatsCollector):
    kind = "weibo_topic_summary"
    label = "微博"

    def publish(self):
        super().publish()
        signature = (self.job["state"], self.job["processedTags"], self.job["requests"], tuple(self.job["errors"]))
        if signature == getattr(self, "_snapshot_signature", None):
            return
        with self.store.lock:
            history = dict(self.store.db.execute(
                "SELECT tag_key,data FROM weibo_tag_history WHERE run_id=?", (self.job["id"],)
            ))
            queue = {tag: (state, note) for tag, state, note in self.store.db.execute(
                "SELECT tag_key,state,note FROM weibo_tag_queue WHERE run_id=?", (self.job["id"],)
            )}
        records = []
        for item in self.plan:
            key = item["key"]
            if key in history:
                records.append(json.loads(history[key]))
            else:
                state, reason = queue.get(key, ("pending", None))
                records.append({
                    "platform": "weibo", "kind": "topic_summary", "tag": item["tag"],
                    "operatorIds": item["operatorIds"], "scope": item["scope"],
                    "status": state, "missingReason": reason, "observedAt": None,
                    "nativeMetrics": {"originalAuthors": None, "discussions": None, "reads": None},
                })
        atomic_json(self.runtime / "topic-counts.json", {
            "metadata": {
                "platform": "weibo", "runId": self.job["id"], "state": self.job["state"],
                "totalTags": len(self.plan), "primaryMetric": "originalAuthors",
                "processedTags": self.job["processedTags"],
                "unavailableTags": self.job["unavailableTags"],
                "operatorsWithData": self.job["operatorsWithData"],
                "completedOperators": self.job["completedOperators"],
                "reusedTags": self.job.get("reusedTags", 0),
                "readableTags": sum(row["nativeMetrics"]["originalAuthors"] is not None for row in records),
                "coverage": "默认精确匹配角色本名，名单中的角色加「明日方舟」。原创人数按话题去重，统计仅覆盖选定话题。",
            },
            "records": records,
        })
        self._snapshot_signature = signature


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("probe", help="读取指定的一个或多个话题")
    probe.add_argument("tags", nargs="+")
    collect = commands.add_parser("collect", help="采集干员话题并保存断点")
    collect.add_argument("--operators", help="逗号分隔的干员中文名或 ID，默认全部档案")
    collect.add_argument("--interval", type=float, default=3.5)
    collect.add_argument("--refresh", action="store_true", help="新建批次")
    commands.add_parser("status", help="查看本地进度")
    commands.add_parser("stop", help="保存进度并停止微博采集")
    args = parser.parse_args(argv)

    if args.command == "status":
        path = RUNTIME / "http-job.json"
        print(path.read_text(encoding="utf-8") if path.is_file() else "尚无微博批量采集任务。")
        return 0
    if args.command == "stop":
        atomic_json(RUNTIME / "http-control.json", {"stop": True})
        print("已请求微博采集保存停止。")
        return 0
    if args.command == "probe":
        with run_lock():
            source = WeiboTopics()
            for tag in args.tags:
                print(json.dumps(source.read(tag), ensure_ascii=False), flush=True)
        return 0

    roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
    selected = {value.strip() for value in (args.operators or "").split(",") if value.strip()}
    operators = [op for op in roster if not selected or {op["name"], op["id"]} & selected]
    matched = {value for op in operators for value in (op["name"], op["id"])}
    if not operators or selected - matched:
        parser.error("存在未收录的干员名称或 ID。")
    with run_lock():
        source = WeiboTopics(args.interval)
        store = TagStatsStore(platform="weibo")
        with closing(store.db):
            collector = WeiboTopicCollector(
                operators, workers=1, interval=args.interval, resume=not args.refresh,
                store=store, source=source, runtime=RUNTIME, plan=make_weibo_plan(operators),
            )
            state = collector.run()
    return 0 if state in ("completed", "partial", "cancelled") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
