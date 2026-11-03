"""角色 TAG 全量分页采集。仅 requests HTTP Session，不启动浏览器。"""

from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import queue
import signal
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))
from tag_session import LOCAL, CollectError, store_session
from tag_sources import SOURCES, now
from tag_match import Matcher, qualified
from tag_store import Store, atomic_json

# 覆盖状态由差到好排序；一位干员名下取最差的那个状态，绝不因为
# 部分标签取完就宣称这位干员已覆盖。
RANK = {
    "exhausted": 0,
    "partial": 1,
    "restricted": 2,
    "failed": 3,
    "blocked": 4,
    "cancelled": 5,
}


class Collector:
    def __init__(
        self, platforms, operators, resume=False, interval=0.7, workers=8, stage="all",
        delay_range=None,
        runtime=None, primary_only=False, halt_on_blocked=False,
    ):
        self.platforms = platforms
        self.operators = operators
        self.matcher = Matcher(operators)
        self.resume = resume
        self.interval = interval
        self.workers = max(1, int(workers))
        self.stage = stage
        self.delay_range = tuple(delay_range) if delay_range else None
        self.runtime = Path(runtime) if runtime is not None else LOCAL
        self.primary_only = primary_only
        self.halt_on_blocked = halt_on_blocked
        self.store = Store()
        self.stopped = threading.Event()
        self.lock = threading.RLock()
        self.active = {}
        self.errors = []
        self.inflight = 0
        self.job = dict(
            id=str(uuid.uuid4()),
            state="running",
            startedAt=now(),
            finishedAt=None,
            completed=0,
            total=len(platforms) * len(operators),
            current="",
            message="纯 HTTP Session，按角色 TAG 全量翻页，无作品数量上限",
            errors=self.errors,
            completedKeys=[],
            plan={
                "platforms": platforms,
                "operatorIds": [o["id"] for o in operators],
                "limit": 0,
                "workers": self.workers,
                "interval": None if self.delay_range else interval,
                "delayRange": self.delay_range,
                "tagScope": "chinese_primary" if primary_only else "all_aliases",
            },
        )

    def stopping(self):
        if self.stopped.is_set():
            return True
        try:
            if json.loads((getattr(self, "runtime", LOCAL) / "http-control.json").read_text()).get("stop"):
                self.stopped.set()
        except (OSError, ValueError):
            pass
        return self.stopped.is_set()

    def progress(self, platform, message=None):
        with self.lock:
            if message:
                self.active[platform] = message
            else:
                self.active.pop(platform, None)
            self.job["active"] = list(self.active.values())
            self.job["current"] = " ｜ ".join(self.active.values())

    def error(self, message):
        with self.lock:
            self.errors.append(message)
            del self.errors[:-100]

    # ---------------------------------------------------------------- 调度单元

    def new_unit(self, platform, operator, tag, kind):
        """一个检索标签 × 一种作品类型 = 一个轮转单元。

        断点是惰性读取的：没轮到的单元不去动数据库里的游标，
        这样中途中断不会把还没开始的标签查询重置成 running。
        """
        return dict(
            key=json.dumps(
                [platform, operator["id"], tag, kind],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            platform=platform,
            operator=operator,
            tag=tag,
            kind=kind,
            cursor=None,
            pages=0,
            start_pages=0,
            stagnant=0,
            loaded=False,
            finished=False,
            state="pending",
            note="",
        )

    def units(self, source):
        return [
            self.new_unit(source.platform, operator, tag, kind)
            for operator in self.operators
            for tag in ([operator["name"]] if getattr(self, "primary_only", False)
                        else self.matcher.aliases(operator, source.platform))
            for kind in source.kinds
        ]

    def load_checkpoint(self, source, unit):
        checkpoint = self.store.query(
            unit["key"],
            unit["platform"],
            unit["operator"]["id"],
            unit["tag"],
            unit["kind"],
            self.resume,
        )
        unit["loaded"] = True
        if checkpoint["done"]:
            unit["finished"] = True
            unit["state"] = "exhausted"
            unit["pages"] = checkpoint["pages"]
            unit["note"] = "断点显示该标签接口已返回结束。"
            return
        unit["cursor"] = checkpoint["cursor"]
        unit["pages"] = checkpoint["pages"]
        unit["start_pages"] = checkpoint["pages"]
        unit["state"] = "running"

    def fail(self, unit, error):
        state = "blocked" if error.kind == "blocked" else "failed"
        self.store.checkpoint(
            unit["key"], unit["cursor"], state, unit["pages"], note=str(error)
        )
        unit.update(state=state, note=str(error), finished=True)
        self.error(
            f'{unit["platform"]} · {unit["operator"]["name"]} · '
            f'#{unit["tag"]} · {unit["kind"]}：{error}'
        )
        if error.kind == "blocked" and getattr(self, "halt_on_blocked", False):
            self.stopped.set()

    def observe(self, source, unit, item):
        """把一行检索结果归属并落库；返回 True 表示遇到封锁，需要停掉本单元。"""
        platform = unit["platform"]
        id = ("novel:" if unit["kind"] == "novels" else "") + item["id"]
        try:
            work = source.row_work(item, unit["kind"])
            if work is None:
                work = self.detail(source, unit, item, id)
            hits = self.matcher.attribute(work["tags"])
            if not hits:
                return False
            tags = list(dict.fromkeys(t for group in hits.values() for t in group))
            # 归属口径按干员分别记：同一件作品可能对能天使是限定标签命中、
            # 对"空"只是裸名命中，网站要能按这两种口径分别统计。
            scopes = {
                oid: ("qualified" if any(qualified(t) for t in group) else "bare")
                for oid, group in hits.items()
            }
            stored = {
                **work,
                "operatorIds": sorted(hits),
                "matchedTags": tags,
                "matchScopes": scopes,
                "matchReason": "原生标签精确等于角色别名：%s。" % "、".join(tags[:5]),
            }
            self.store.put(stored)
            # 点赞只有详情接口给：先记进队列，指标阶段按断点逐件补。
            if source.deferred_metrics and stored["likes"] is None:
                self.store.queue_metric(platform, stored["id"], unit["kind"])
            return False
        except CollectError as error:
            if error.kind == "blocked":
                self.fail(unit, error)
                return True
            self.store.fault(unit["key"], item["id"], str(error))
            self.error(
                f'{platform} · {unit["operator"]["name"]} · {item["id"]}：{error}'
            )
            return False

    def detail(self, source, unit, item, id):
        """必须逐件请求详情的平台走这里；一小时内已取过的不重复请求。"""
        cached = self.store.get(unit["platform"], id)
        if cached:
            age = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(cached["observedAt"].replace("Z", "+00:00"))
            ).total_seconds()
            if age < 3600:
                return cached
        return source.detail(item, unit["kind"])

    def step(self, source, unit):
        """推进一页；返回 True 表示本单元已结束（取完／受限／失败／取消）。"""
        if not unit["loaded"]:
            self.load_checkpoint(source, unit)
        if unit["finished"]:
            return True
        if self.stopping():
            unit.update(state="cancelled", finished=True)
            return True
        key = unit["key"]
        cursor = unit["cursor"]
        self.progress(
            unit["platform"],
            f'{unit["platform"]} · {unit["operator"]["name"]} · '
            f'#{unit["tag"]} · {unit["kind"]} 第 {unit["pages"]+1} 页',
        )
        try:
            page = source.page(unit["tag"], unit["kind"], cursor)
        except CollectError as error:
            self.fail(unit, error)
            return True
        new = 0
        for item in page.items:
            if self.stopping():
                unit.update(state="cancelled", finished=True)
                return True
            new += self.store.seen(key, item["id"])
            if self.observe(source, unit, item):
                return True
        unit["pages"] += 1
        count, failures = self.store.query_counts(key)
        if page.done:
            state = "partial" if failures else "exhausted"
            if page.restricted or (
                page.advertised is not None and count < page.advertised
            ):
                state = "restricted"
            note = (
                "接口返回结束；缺失详情保留失败记录。"
                if failures
                else "接口返回结束。"
            )
            self.store.checkpoint(
                key, page.cursor, state, unit["pages"], page.advertised, note
            )
            unit.update(
                cursor=page.cursor, state=state, note=note, finished=True
            )
            return True
        # 断点续采时第一页会重放已入库的条目，重放不算原地踏步。
        replay = self.resume and unit["pages"] == unit["start_pages"] + 1
        unit["stagnant"] = unit["stagnant"] + 1 if not new and not replay else 0
        if unit["stagnant"] >= 3 or page.cursor == cursor:
            note = "分页重复、游标未前进或提前为空，不能标为已取完。"
            self.store.checkpoint(
                key, cursor, "restricted", unit["pages"], page.advertised, note
            )
            unit.update(state="restricted", note=note, finished=True)
            return True
        unit["cursor"] = page.cursor
        unit["state"] = "running"
        self.store.checkpoint(key, page.cursor, "running", unit["pages"], page.advertised)
        return False

    def crawl_query(self, source, operator, tag, kind):
        """把单个标签查询一路取到底；轮转调度之外的兼容入口。"""
        unit = self.new_unit(source.platform, operator, tag, kind)
        while not unit["finished"]:
            self.step(source, unit)
        count, failures = self.store.query_counts(unit["key"])
        return {
            "tag": tag,
            "kind": kind,
            "state": unit["state"],
            "candidates": count,
            "failures": failures,
            "pages": unit["pages"],
            "note": unit["note"],
        }

    # ---------------------------------------------------------------- 平台层

    def create_source(self, platform):
        source = SOURCES[platform](self.interval)
        if platform == "pixiv" and getattr(self, "delay_range", None) is not None:
            source.session.set_random_delay(*self.delay_range)
        return source

    def crawl_platform(self, platform):
        units = []
        failure = None
        note = ""
        try:
            source = self.create_source(platform)
            units = self.units(source)
            self.run_units(platform, source, units)
        except CollectError as error:
            failure = "blocked" if error.kind == "blocked" else "failed"
            note = str(error)
            self.error(f"{platform}：{note}")
        except Exception as error:
            failure = "failed"
            note = (
                f"脚本异常（{type(error).__name__}），已保留断点；"
                "未输出请求头或会话内容。"
            )
            self.error(f"{platform}：{note}")
        finally:
            self.progress(platform)
        if units:
            self.record_coverage(platform, units)
        elif failure:
            # 适配器都没建起来，一个单元也没跑：把这次不可用如实记到每位干员名下，
            # 不能让覆盖表看起来像"没有需要覆盖的东西"。
            for operator in self.operators:
                self.store.coverage(
                    dict(
                        platform=platform,
                        operatorId=operator["id"],
                        status=failure,
                        candidates=0,
                        matched=self.store.matched(platform, operator["id"]),
                        checkedAt=now(),
                        note=note + " 本次一个标签查询都没开始。",
                        queries=[],
                        unbounded=True,
                    )
                )

    def run_units(self, platform, source, units):
        """公平轮转：一个单元取一页就排到队尾，轮到下一位干员。

        大标签不会被优先吃干抹净；并发压满 --workers，
        单个标签被封锁只结束它自己那一个单元，不停整个平台。
        """
        tasks = queue.Queue()
        for unit in units:
            tasks.put(unit)

        def worker():
            while not self.stopping():
                try:
                    unit = tasks.get_nowait()
                except queue.Empty:
                    with self.lock:
                        idle = not self.inflight
                    if idle:
                        return
                    time.sleep(0.05)
                    continue
                done = True
                with self.lock:
                    self.inflight += 1
                try:
                    try:
                        done = self.step(source, unit)
                    except CollectError as error:
                        self.fail(unit, error)
                    except Exception as error:
                        note = f"脚本异常（{type(error).__name__}），已保留断点。"
                        self.store.checkpoint(
                            unit["key"],
                            unit["cursor"],
                            "failed",
                            unit["pages"],
                            note=note,
                        )
                        unit.update(state="failed", note=note, finished=True)
                        self.error(
                            f'{platform} · {unit["operator"]["name"]} · '
                            f'#{unit["tag"]}：{note}'
                        )
                        self.error(str(error))
                    # 先归队再撤下在途计数，避免别的线程误判队列已排空。
                    if not done and not self.stopping():
                        tasks.put(unit)
                    elif not done:
                        unit.update(state="cancelled", finished=True)
                finally:
                    with self.lock:
                        self.inflight -= 1

        with ThreadPoolExecutor(
            max_workers=self.workers, thread_name_prefix=platform
        ) as executor:
            for _ in range(min(self.workers, len(units))):
                executor.submit(worker)

    def record_coverage(self, platform, units):
        grouped = {}
        for unit in units:
            grouped.setdefault(unit["operator"]["id"], []).append(unit)
        done = 0
        for operator in self.operators:
            mine = grouped.get(operator["id"], [])
            queries = []
            for unit in mine:
                row = dict(
                    tag=unit["tag"],
                    kind=unit["kind"],
                    state=unit["state"],
                    pages=unit["pages"],
                )
                if unit["finished"]:
                    row["candidates"] = self.store.query_counts(unit["key"])[0]
                if unit["note"]:
                    row["note"] = unit["note"]
                queries.append(row)
            started = [u for u in mine if u["state"] != "pending"]
            left = [u for u in mine if not u["finished"]]
            if not mine:
                status = "pending"
                note = "该干员没有可用的检索标签。"
            elif not started:
                status = "pending"
                note = f"{len(mine)} 个标签查询本次都没轮到，断点保持不变。"
            else:
                status = max((u["state"] for u in started), key=lambda s: RANK[s])
                note = (
                    "配置的角色标签列表均已返回结束。"
                    if status == "exhausted"
                    else f"状态 {status}；{len(left)} 个标签查询未取完，不是完整结果。"
                )
            matched = self.store.matched(platform, operator["id"])
            if status == "exhausted" and not left:
                done += 1
            self.store.coverage(
                dict(
                    platform=platform,
                    operatorId=operator["id"],
                    status=status,
                    candidates=sum(q.get("candidates", 0) for q in queries),
                    matched=matched,
                    checkedAt=now(),
                    note=note,
                    queries=queries,
                    unbounded=True,
                )
            )
            with self.lock:
                self.job["completed"] += 1
                if status == "exhausted":
                    self.job["completedKeys"].append(
                        platform + ":" + operator["id"]
                    )
        return done

    def fill_metrics(self, platform):
        """补齐点赞与播放：这两项只有作品详情接口给，必须逐件请求。

        翻页阶段已经把作品、原生标签与归属落库，这里只更新指标；
        取不到的留在队列里等下次接着补，不写成 0，也不当作没有。
        """
        pending = self.store.pending_metrics(platform)
        if not pending:
            return
        source = self.create_source(platform)
        tasks = queue.Queue()
        for row in pending:
            tasks.put(row)
        halt = threading.Event()

        def worker():
            while not self.stopping() and not halt.is_set():
                try:
                    row = tasks.get_nowait()
                except queue.Empty:
                    return
                with self.lock:
                    self.inflight += 1
                try:
                    if self.metric(source, platform, row) == "blocked":
                        halt.set()
                finally:
                    with self.lock:
                        self.inflight -= 1

        with ThreadPoolExecutor(
            max_workers=self.workers, thread_name_prefix=platform + "-指标"
        ) as executor:
            for _ in range(min(self.workers, len(pending))):
                executor.submit(worker)
        left = self.store.metrics_remaining(platform)
        self.progress(platform, f"{platform} 指标：{left} 件仍未取到点赞与播放。")
        if left:
            self.error(
                f"{platform}：仍有 {left} 件作品的点赞与播放未取到，"
                "已留在指标队列里等下次补，没有写成 0。"
            )

    def metric(self, source, platform, row):
        """补一件作品的指标；返回 True 表示取到，'blocked' 表示该平台要停。"""
        id, kind = row["id"], row["kind"]
        work = self.store.get(platform, id)
        if work is None:
            return False
        if work.get("likes") is not None:
            self.store.dequeue_metric(platform, id)
            return False
        try:
            fresh = source.detail({"id": id.split(":", 1)[-1]}, kind)
        except CollectError as error:
            self.error(f"{platform} · 指标 · {id}：{error}")
            return "blocked" if error.kind == "blocked" else False
        self.store.put({**work, **fresh})
        return True

    def supervise(self, task):
        with ThreadPoolExecutor(max_workers=len(self.platforms)) as executor:
            futures = [executor.submit(task, p) for p in self.platforms]
            last = time.monotonic()
            while not all(f.done() for f in futures):
                with self.lock:
                    atomic_json(self.runtime / "http-job.json", self.job)
                if time.monotonic() - last > 30:
                    # 进度只读一个 COUNT；作品明细留在 SQLite，不反复导出大 JSON。
                    print(
                        f"{self.store.count_works()} 件作品 · "
                        f'{self.job["completed"]}/{self.job["total"]} 组 · '
                        f'{self.job["current"]}',
                        flush=True,
                    )
                    last = time.monotonic()
                time.sleep(2)

    def run(self):
        atomic_json(self.runtime / "http-control.json", {"stop": False})
        atomic_json(self.runtime / "http-job.json", self.job)
        signal.signal(signal.SIGINT, lambda *_: self.stopped.set())
        if self.stage in ("all", "tags"):
            self.supervise(self.crawl_platform)
        if self.stage in ("all", "metrics") and not self.stopping():
            self.supervise(self.fill_metrics)
        if self.stopping():
            state = "cancelled"
        elif self.stage == "metrics":
            state = "completed"
        elif len(self.job["completedKeys"]) == self.job["total"]:
            state = "completed"
        else:
            state = "failed"
        self.job["state"] = state
        self.job["finishedAt"] = now()
        self.job["current"] = ""
        data = self.store.export()
        left = sum(self.store.metrics_remaining(p) for p in self.platforms)
        self.job["message"] = (
            f'已保存 {data["metadata"]["workCount"]} 件作品，'
            f'{len(self.job["completedKeys"])} 组配置标签已翻页至接口结束；'
            + (
                f"其中 {left} 件的点赞与播放尚未取到，留在指标队列里等下次补。"
                if left
                else "点赞与播放已全部取到。"
            )
            + "其余范围与受限情况见覆盖记录。"
        )
        atomic_json(self.runtime / "http-job.json", self.job)
        print(self.job["message"], flush=True)


def main(argv=None, *, runtime=None, primary_only=False, halt_on_blocked=False):
    runtime = Path(runtime) if runtime is not None else LOCAL
    parser = argparse.ArgumentParser(
        description="纯 HTTP Session 角色标签全量采集，不启动浏览器、不设作品数量上限。"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    collect = sub.add_parser("collect")
    collect.add_argument("--platforms")
    collect.add_argument("--operators")
    collect.add_argument("--ids")
    collect.add_argument("--resume", action="store_true")
    collect.add_argument("--interval", type=float, default=0.7)
    collect.add_argument(
        "--delay-range", nargs=2, type=float, metavar=("最小秒数", "最大秒数"),
        help="Pixiv 每个线程在每次请求前随机休眠，启用后替代固定 --interval。",
    )
    collect.add_argument("--workers", type=int, default=8)
    collect.add_argument(
        "--stage",
        choices=("all", "tags", "metrics"),
        default="all",
        help="tags 只翻页落库，metrics 只补点赞与播放，all 两段都跑。",
    )
    sub.add_parser("status")
    sub.add_parser("stop")
    sub.add_parser("export")
    session = sub.add_parser("session")
    session.add_argument("--platform", required=True, choices=list(SOURCES))
    args = parser.parse_args(argv)
    if args.command == "session":
        store_session(args.platform)
        return
    if args.command == "status":
        p = runtime / "http-job.json"
        print(p.read_text(encoding="utf-8") if p.exists() else "尚无纯 HTTP 采集任务。")
        return
    if args.command == "stop":
        atomic_json(runtime / "http-control.json", {"stop": True})
        print("已请求停止，当前 HTTP 请求返回后保存退出。")
        return
    if args.command == "export":
        data = Store().export()
        print(f'已汇总 {data["metadata"]["workCount"]} 件作品到网站 JSON。')
        return
    # --resume 只表示"接着数据库里的断点跑"，不继承上一次的采集范围。
    # 继承过一次就出事：上一回只试了一位干员，这一回不写 --operators
    # 就被悄悄缩成一位，看起来还"已完成"，实际离全量差得远。
    platforms = list(dict.fromkeys((args.platforms or ",".join(SOURCES)).split(",")))
    if not platforms or any(p not in SOURCES for p in platforms):
        parser.error("指定平台尚无纯 HTTP 适配器。")
    operators = json.loads(
        (ROOT / "public/data/operators.json").read_text(encoding="utf-8")
    )
    selected = set((args.operators or args.ids or "").split(",")) - {""}
    if selected:
        operators = [
            o for o in operators if o["id"] in selected or o["name"] in selected
        ]
        if not operators or any(
            not any(o["id"] == value or o["name"] == value for o in operators)
            for value in selected
        ):
            parser.error("存在未收录的干员名称或 ID。")
    minimum_interval = 0.2
    if not math.isfinite(args.interval) or args.interval < minimum_interval:
        parser.error(f"请求间隔需为有限数值，且至少 {minimum_interval:g} 秒。")
    if args.delay_range is not None:
        minimum, maximum = args.delay_range
        if platforms != ["pixiv"]:
            parser.error("随机休眠参数当前只用于 Pixiv 单平台任务。")
        if not all(math.isfinite(v) for v in (minimum, maximum)) or not 0.2 <= minimum <= maximum:
            parser.error("随机休眠需满足 0.2 <= 最小秒数 <= 最大秒数，且均为有限数值。")
    if not 1 <= args.workers <= 32:
        parser.error("线程数需在 1 到 32 之间。")
    runtime.mkdir(parents=True, exist_ok=True)
    with (runtime / "http-run.lock").open("a+b") as lock:
        import msvcrt

        lock.seek(0)
        lock.write(b"1")
        lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise CollectError("已有 HTTP 脚本在采集，不能重复启动。") from None
        Collector(
            platforms, operators, args.resume, args.interval, args.workers, args.stage,
            args.delay_range,
            runtime=runtime, primary_only=primary_only, halt_on_blocked=halt_on_blocked,
        ).run()


if __name__ == "__main__":
    try:
        main()
    except CollectError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # 不把底层 HTTP 异常中的 URL、签名或 Cookie 打到终端。
        print(
            f"采集未完成（{type(error).__name__}）；已保存断点，请查看本地任务状态。",
            file=sys.stderr,
        )
        sys.exit(1)
