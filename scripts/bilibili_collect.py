"""B站434位干员的角色＋明日方舟＋联动作组合搜索结果数。"""

import argparse
from contextlib import closing, contextmanager
import json
import math
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from bilibili_search_runtime import BilibiliSearchCollector as BilibiliCountCollector, RUNTIME
from bilibili_search_export import export_counts
from collector_sources.bilibili_search_totals import BilibiliSearchTotals
from tag_session import CollectError, LOCAL, store_session
from tag_store import atomic_json


@contextmanager
def run_lock():
    import msvcrt
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with (RUNTIME / "http-run.lock").open("a+b") as file:
        file.seek(0); file.write(b"1"); file.flush(); file.seek(0)
        try:
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CollectError("已有B站任务运行，不能重复启动。") from None
        try:
            yield
        finally:
            file.seek(0); msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect")
    collect.add_argument("--operators", help="中文名或ID，逗号分隔；默认全部434位。")
    collect.add_argument("--workers", type=int, choices=[1], default=1, help="数量采集固定单线程。")
    collect.add_argument("--interval", type=float, default=3.5, help="每次请求最小间隔秒数，至少1秒。")
    resume = collect.add_mutually_exclusive_group()
    resume.add_argument("--resume", dest="resume", action="store_true", default=True)
    resume.add_argument("--refresh", dest="resume", action="store_false")
    sub.add_parser("status"); sub.add_parser("stop"); sub.add_parser("stats")
    sub.add_parser("export", help="将已保存的累计数量导出给网站，不发送平台请求。")
    sub.add_parser("session")
    sub.add_parser("reset", help="清除旧B站数据和断点，不影响LOFTER、Pixiv及凭据。")
    probe = sub.add_parser("probe")
    probe.add_argument("--tag", default="黍")
    args = parser.parse_args(argv)
    if args.command == "stop":
        atomic_json(RUNTIME / "http-control.json", {"stop": True})
        print("已请求B站标签数量任务保存停止。")
        return 0
    if args.command == "status":
        p = RUNTIME / "http-job.json"
        print(p.read_text(encoding="utf-8") if p.exists() else "尚无B站标签数量任务。")
        return 0
    if args.command == "session":
        store_session("bilibili"); return 0
    if args.command == "reset":
        from bilibili_cleanup import reset_counts
        with run_lock():
            print(json.dumps(reset_counts(), ensure_ascii=False))
            export_counts()
        return 0
    if args.command == "export":
        data = export_counts()
        print(json.dumps(data["metadata"], ensure_ascii=False)); return 0
    if args.command == "probe":
        from tempfile import TemporaryDirectory
        from lofter_tag_stats import TagStatsStore
        roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
        operators = [o for o in roster if o["name"] == args.tag]
        if not operators:
            parser.error("未收录这个角色标签。")
        with TemporaryDirectory() as directory:
            store = TagStatsStore(Path(directory), "bilibili")
            source = BilibiliSearchTotals(operators)
            source.bind(store, "probe")
            try:
                print(json.dumps(source.read(args.tag), ensure_ascii=False))
            finally:
                store.db.close()
        return 0
    if args.command == "stats":
        path = LOCAL / "http-collection.sqlite"
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='bilibili_tag_stats'").fetchone()
            rows = db.execute("SELECT data FROM bilibili_tag_stats ORDER BY tag_key").fetchall() if exists else []
        print("角色\t组合搜索结果数\t检索范围\t采集时间")
        for encoded, in rows:
            item = json.loads(encoded)
            if item.get("countBasis") != "search_result_total":
                continue
            value = item.get("workCount")
            print(item["tag"], value if value is not None else "未取得", "已遍历检索范围" if item.get("complete") else "部分", item["observedAt"], sep="\t")
        return 0
    if not math.isfinite(args.interval) or args.interval < 1:
        parser.error("标签数量采集间隔需为有限值且至少1秒。")
    roster = json.loads((ROOT / "public/data/operators.json").read_text(encoding="utf-8"))
    selected = set((args.operators or "").split(",")) - {""}
    operators = [o for o in roster if not selected or o["name"] in selected or o["id"] in selected]
    if not operators or any(not any(v in (o["name"], o["id"]) for o in operators) for v in selected):
        parser.error("存在未收录的干员名称或ID。")
    from bilibili_tag_rules import rules_for
    operators.sort(key=lambda o: (0 if o["name"] == "爱丽丝" else 1 if len(rules_for(o)) == 3 else 2, o["name"]))
    with run_lock():
        collector = BilibiliCountCollector(operators, interval=args.interval, resume=args.resume, runtime=RUNTIME)
        try:
            state = collector.run()
        finally:
            collector.store.db.close()
    return 0 if state == "completed" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr); raise SystemExit(1) from None
    except Exception as error:
        print(f"B站标签数量采集未完成（{type(error).__name__}），已保留断点。", file=sys.stderr)
        raise SystemExit(1) from None
