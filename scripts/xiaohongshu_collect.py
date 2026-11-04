"""小红书干员话题浏览量采集。"""

import argparse
from contextlib import closing, contextmanager
import json
import math
import msvcrt
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from collector_sources.xiaohongshu_topics import XiaohongshuTopics
from character_topic_rules import make_character_topic_plan as make_plan
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import CollectError, LOCAL
from tag_store import atomic_json


RUNTIME = LOCAL / "xiaohongshu"


@contextmanager
def run_lock():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / "http-run.lock").open("a+b") as file:
        file.seek(0)
        try:
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CollectError("已有小红书话题采集任务运行。") from None
        try:
            yield
        finally:
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


class XiaohongshuTopicCollector(TagStatsCollector):
    kind = "xiaohongshu_topic_summary"
    label = "小红书"

    def publish(self):
        super().publish()
        signature = (self.job["state"], self.job["requests"], self.job["processedTags"])
        if signature == getattr(self, "_snapshot_signature", None):
            return
        with self.store.lock:
            history = dict(self.store.db.execute(
                "SELECT tag_key,data FROM xiaohongshu_tag_history WHERE run_id=?",
                (self.job["id"],),
            ))
            queue = {key: (state, reason) for key, state, reason in self.store.db.execute(
                "SELECT tag_key,state,note FROM xiaohongshu_tag_queue WHERE run_id=?",
                (self.job["id"],),
            )}
        records = []
        for item in self.plan:
            key = item["key"]
            if key in history:
                records.append(json.loads(history[key]))
                continue
            state, reason = queue.get(key, ("pending", None))
            records.append({
                "platform": "xiaohongshu", "kind": "topic_summary", "tag": item["tag"],
                "operatorIds": item["operatorIds"], "scope": item["scope"],
                "topicId": None, "url": None, "publishedAt": None, "observedAt": None,
                "nativeMetrics": {"view_num": None}, "status": state, "missingReason": reason,
            })
        readable = sum(row["nativeMetrics"]["view_num"] is not None for row in records)
        unavailable = sum(row["status"] == "unavailable" for row in records)
        atomic_json(self.runtime / "topic-counts.json", {
            "metadata": {
                "platform": "xiaohongshu", "runId": self.job["id"], "state": self.job["state"],
                "totalOperators": self.job["totalOperators"], "totalTags": len(self.plan),
                "processedTags": readable + unavailable, "readableTags": readable,
                "unavailableTags": unavailable, "metric": "view_num",
                "coverage": "精确匹配角色名话题，名单中的同名角色加「明日方舟」前缀。未匹配的话题留空。",
            },
            "records": records,
        })
        self._snapshot_signature = signature


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ("session", "works"):
        from platform_entry import run
        return run("xiaohongshu", args[1:] if args[0] == "works" else args)

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("probe", "collect"):
        sub = commands.add_parser(command)
        sub.add_argument("--operators", required=command == "probe", help="逗号分隔的干员名或 ID")
        sub.add_argument("--interval", type=float, default=3.5)
        if command == "collect":
            sub.add_argument("--refresh", action="store_true", help="新建批次")
    commands.add_parser("status", help="查看话题采集进度")
    commands.add_parser("stop", help="保存并停止话题采集")
    commands.add_parser("session", help="在本机隐藏输入并保存会话")
    commands.add_parser("works", help="访问旧的逐作品采集命令")
    args = parser.parse_args(args or ["--help"])
    if args.command == "status":
        path = RUNTIME / "http-job.json"
        print(path.read_text(encoding="utf-8") if path.is_file() else "尚无小红书话题采集任务。")
        return 0
    if args.command == "stop":
        atomic_json(RUNTIME / "http-control.json", {"stop": True})
        print("已请求小红书话题采集保存停止。")
        return 0
    if not math.isfinite(args.interval) or args.interval < 3.5:
        parser.error("小红书话题请求间隔至少为 3.5 秒。")

    roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
    selected = {value.strip() for value in (args.operators or "").split(",") if value.strip()}
    if args.operators is not None and not selected:
        parser.error("请指定有效的干员名称或 ID。")
    operators = [op for op in roster if not selected or {op["name"], op["id"]} & selected]
    if not operators or selected - {value for op in operators for value in (op["name"], op["id"])}:
        parser.error("存在未收录的干员名称或 ID。")
    plan = make_plan(operators)
    with run_lock():
        source = XiaohongshuTopics(args.interval)
        if args.command == "probe":
            for item in plan:
                print(json.dumps(source.read(item["tag"]), ensure_ascii=False), flush=True)
            return 0
        store = TagStatsStore(platform="xiaohongshu")
        with closing(store.db):
            state = XiaohongshuTopicCollector(
                operators, workers=1, interval=args.interval, resume=not args.refresh,
                store=store, source=source, runtime=RUNTIME, plan=plan,
            ).run()
    return 0 if state in ("completed", "partial", "cancelled") else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
