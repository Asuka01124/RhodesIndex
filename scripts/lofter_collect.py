"""LOFTER 角色标签汇总：只读取434位干员的中文主标签浏览和参与。"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from collector_sources.lofter_tags import LofterTags
from lofter_tag_stats import RUNTIME, TagStatsCollector
from tag_session import CollectError, LOCAL, store_session
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
            raise CollectError("已有 LOFTER 任务运行，不能重复启动。") from None
        try:
            yield
        finally:
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect", help="读取或接续全部角色标签统计")
    collect.add_argument("--operators", help="干员名称或 ID，用逗号分隔；默认全部 434 位。")
    collect.add_argument("--workers", type=int, default=3)
    collect.add_argument("--interval", type=float, default=3.5, help="全体线程共用的最小请求间隔（秒）。")
    collect.add_argument("--primary-only", action="store_true", default=True, help="仅中文主标签，默认启用；保留此参数兼容旧命令。")
    group = collect.add_mutually_exclusive_group()
    group.add_argument("--resume", dest="resume", action="store_true", default=True, help="接续未完成批次，默认启用。")
    group.add_argument("--refresh", dest="resume", action="store_false", help="重新读取当前标签统计，保留已保存的标签快照。")
    sub.add_parser("status", help="查看 LOFTER 独立进度")
    sub.add_parser("stop", help="保存停止，不影响 Pixiv")
    sub.add_parser("session", help="隐藏输入 Cookie 并用 DPAPI 加密保存")
    probe = sub.add_parser("probe", help="验证一个标签统计，不写数据库")
    probe.add_argument("--tag", default="拉普兰德")
    sub.add_parser("stats", help="显示每个标签的原始浏览和参与统计，不求和")
    sub.add_parser("export", help="将已采集标签统计整理到网站，不请求LOFTER。")
    args = parser.parse_args(argv)
    if args.command == "export":
        from lofter_tag_export import export_counts
        print(json.dumps(export_counts()["metadata"], ensure_ascii=False))
        return 0
    if args.command == "session":
        store_session("lofter")
        return 0
    if args.command == "status":
        path = RUNTIME / "http-job.json"
        print(path.read_text(encoding="utf-8") if path.exists() else "尚无 LOFTER 标签采集任务。")
        return 0
    if args.command == "stop":
        atomic_json(RUNTIME / "http-control.json", {"stop": True})
        print("已请求 LOFTER 保存停止，不影响其他平台。")
        return 0
    if args.command == "probe":
        print(json.dumps(LofterTags().read(args.tag), ensure_ascii=False))
        return 0
    if args.command == "stats":
        with sqlite3.connect((LOCAL / "http-collection.sqlite").as_uri() + "?mode=ro", uri=True) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lofter_tag_stats'").fetchone()
            rows = db.execute("SELECT data FROM lofter_tag_stats ORDER BY tag_key").fetchall() if exists else []
        print("标签\t浏览（原始显示）\t参与（原始显示）\t关联干员 ID\t采集时间")
        for encoded, in rows:
            item = json.loads(encoded)
            print(item["tag"], item["views"]["display"] or "未取得", item["participation"]["display"] or "未取得",
                  ",".join(item["operatorIds"]), item["observedAt"], sep="\t")
        return 0
    if not 1 <= args.workers <= 16 or not math.isfinite(args.interval) or args.interval < 1:
        parser.error("线程数需为 1–16，请求间隔至少 1 秒。")
    roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
    selected = set((args.operators or "").split(",")) - {""}
    operators = [o for o in roster if not selected or o["id"] in selected or o["name"] in selected]
    if not operators or any(not any(o["id"] == v or o["name"] == v for o in operators) for v in selected):
        parser.error("存在未收录的干员名称或 ID。")
    with run_lock():
        collector = TagStatsCollector(operators, roster, args.workers, args.interval,
                                      args.resume, args.primary_only)
        try:
            state = collector.run()
        finally:
            collector.store.db.close()
    return 0 if state == "completed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as error:
        print(f"LOFTER 标签统计未完成（{type(error).__name__}），进度保留，未输出会话内容。", file=sys.stderr)
        raise SystemExit(1) from None
