"""抖音中文主话题累计播放量；独立纯 HTTP 采集与单标签试采。"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from collector_sources.base import now
from collector_sources.douyin_topics import DouyinTopics
from douyin_session import main as session_main
from douyin_topic_runtime import DouyinTopicCollector, DouyinTopicStore, RUNTIME, reconcile_topic_mapping
from tag_session import CollectError, LOCAL
from tag_store import atomic_json


@contextmanager
def run_lock():
    import msvcrt

    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / "http-run.lock").open("a+b") as file:
        file.seek(0)
        file.write(b"1")
        file.flush()
        file.seek(0)
        try:
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CollectError("已有抖音采集任务运行，不能重复启动。") from None
        try:
            yield
        finally:
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    probe = sub.add_parser("probe", help="读取一个精确同名话题及接口返回的相关话题")
    probe.add_argument("--tag", default="阿尔图罗")
    probe.add_argument("--interval", type=float, default=3.5)
    sub.add_parser("session", help="本机隐藏输入并加密保存会话")
    sub.add_parser("session-status", help="只检查本地会话是否可读取")
    sub.add_parser("remap", help="离线修正人物话题映射，保留旧历史和真实采集时间")
    sub.add_parser("export", help="把已保存的话题统计导出到网站，不请求抖音")
    collect = sub.add_parser("collect", help="读取或接续434位干员的中文主话题")
    collect.add_argument("--operators", help="中文干员名称或ID，以英文逗号分隔；默认全部434位")
    collect.add_argument("--interval", type=float, default=3.5)
    group = collect.add_mutually_exclusive_group()
    group.add_argument("--resume", dest="resume", action="store_true", default=True)
    group.add_argument("--refresh", dest="resume", action="store_false")
    sub.add_parser("status", help="读取本地任务进度，不访问抖音")
    sub.add_parser("stop", help="请求抖音任务保存停止，不影响其他平台")
    args = parser.parse_args(argv)
    if args.command == "session":
        return session_main([])
    if args.command == "session-status":
        return session_main(["--status"])
    if args.command == "export":
        from douyin_topic_export import export_counts
        print(json.dumps(export_counts()["metadata"], ensure_ascii=False))
        return 0
    if args.command == "remap":
        roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
        with run_lock():
            store = DouyinTopicStore()
            try:
                job = reconcile_topic_mapping(roster, store)
            finally:
                store.db.close()
        print(json.dumps({key: job[key] for key in ["state", "totalOperators", "totalTags", "processedTags", "reusedTags", "errors"]}, ensure_ascii=False))
        return 0
    if args.command == "status":
        path = RUNTIME / "http-job.json"
        print(path.read_text(encoding="utf-8") if path.exists() else "尚无抖音批量采集任务。")
        return 0
    if args.command == "stop":
        atomic_json(RUNTIME / "http-control.json", {"stop": True})
        print("已请求抖音采集保存停止，不影响其他平台。")
        return 0
    if args.command == "collect":
        if not math.isfinite(args.interval) or args.interval < 3.5:
            parser.error("抖音请求间隔至少为3.5秒。")
        roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
        selected = {value.strip() for value in (args.operators or "").split(",") if value.strip()}
        operators = [operator for operator in roster if not selected or operator["id"] in selected or operator["name"] in selected]
        if not operators or any(not any(operator["id"] == value or operator["name"] == value for operator in operators) for value in selected):
            parser.error("存在未收录的干员名称或ID。")
        with run_lock():
            collector = DouyinTopicCollector(operators, interval=args.interval, resume=args.resume)
            try:
                state = collector.run()
            finally:
                collector.store.db.close()
        return 0 if state in ("completed", "partial", "cancelled") else 1
    target = LOCAL / "douyin" / "probe-topic.json"
    try:
        result = DouyinTopics(args.interval).read(args.tag)
    except CollectError as error:
        failure = {"platform": "douyin", "tag": args.tag, "status": error.kind, "observedAt": now(), "playCount": None, "reason": str(error)}
        atomic_json(LOCAL / "douyin" / "probe-last-error.json", failure)
        # 失败另存，保留此前成功的来源和统计，不用空值覆盖它。
        raise
    atomic_json(target, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        print("抖音采集已取消，已保存进度可继续。", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception:
        print("抖音试采未完成；未输出凭据或将失败当作零。", file=sys.stderr)
        raise SystemExit(1) from None
