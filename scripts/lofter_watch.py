"""LOFTER 标签统计监视器：只读标签快照和任务进度，不访问平台。"""

from __future__ import annotations

import argparse
from collections import deque
from contextlib import closing
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

from pixiv_watch import rate

ROOT = Path(__file__).resolve().parents[1]


def snapshot(directory):
    job_path = directory / "lofter/http-job.json"
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        heartbeat = max(0, time.time() - job_path.stat().st_mtime)
    except (OSError, ValueError):
        job, heartbeat = {}, None
    uri = (directory / "http-collection.sqlite").resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        count = db.execute("SELECT COUNT(*) FROM lofter_tag_stats").fetchone()[0] if "lofter_tag_stats" in tables else 0
        states = dict(db.execute("SELECT state,COUNT(*) FROM lofter_tag_queue WHERE run_id=? GROUP BY state", (job.get("id"),)).fetchall()) if "lofter_tag_queue" in tables else {}
    job = {**job, "savedTagRecords": count}
    processed = states.get("completed", 0) + states.get("unavailable", 0)
    return processed, states, job, heartbeat


def render(history, calls, details, last_change, initial, interval, trend):
    processed, states, job, heartbeat = details
    delta = processed - history[-2][1] if len(history) > 1 else 0
    seconds = history[-1][0] - history[-2][0] if len(history) > 1 else 0
    speed = delta / seconds if seconds else 0
    minute, minute_age = rate(history, 60)
    five, five_age = rate(history, 300)
    average, age = rate(history, float("inf"))
    request_rate, _ = rate(calls, 60)
    stale = history[-1][0] - last_change
    state = job.get("state")
    status = {"running": "运行中", "cancelled": "已停止", "completed": "本轮已结束",
              "partial": "本轮已遍历，部分标签缺失", "failed": "本轮有未完成项"}.get(state, "等待任务")
    if state == "running":
        if heartbeat is None or heartbeat > 20:
            status += " / 心跳未更新，请核实采集器"
        elif stale > 30:
            status += " / 暂无新标签完成，可能在等待响应或退避"
    peak = max(trend, default=0)
    levels = "▁▂▃▄▅▆▇█"
    chart = "".join(levels[min(7, int(value / peak * 7))] if peak else "▁" for value in trend)
    current_speed = f"{speed:8.2f} 标签/秒    {speed * 60:8.1f} 标签/分钟" if seconds else "采样中，下次刷新开始计算"
    error = str((job.get("errors") or ["暂无"])[-1]).replace("\n", " ")[:85]
    latest = job.get("lastObservation") or {}
    views = latest.get("views") or {}
    participation = latest.get("participation") or {}
    total = job.get("totalTags", 0)
    eta = f"{max(0,total-processed) / minute / 60:.1f} 分钟（不含失败重试）" if minute > 0 and state == "running" else "等待足够的速度样本"
    return [
        "LOFTER 标签统计监视器",
        "=" * 66,
        f"更新时间  {datetime.now():%Y-%m-%d %H:%M:%S}    每 {interval:g} 秒刷新",
        f"任务状态  {status}", "",
        f"当前速度    {current_speed}",
        f"近 1 分钟   {minute:8.2f} 标签/秒    {minute * 60:8.1f} 标签/分钟",
        f"近 5 分钟   {five:8.2f} 标签/秒    {five * 3600:8.0f} 标签/小时",
        f"观察期均速  {average:8.2f} 标签/秒    已观察 {age / 60:.1f} 分钟", "",
        f"本轮已处理标签  {processed:,} / {total:,}",
        f"可读统计 {states.get('completed',0):,}  无法取得 {states.get('unavailable',0):,}  失败 {states.get('failed',0):,}",
        f"已有可读统计的干员  {job.get('operatorsWithData',0):,} / {job.get('totalOperators',0):,}",
        f"接口调用 {job.get('requests',0):,} 次    近分钟 {request_rate*60:.1f} 次/分",
        f"粗估剩余  {eta}",
        f"当前处理  {str(job.get('current') or '等待任务更新')[:70]}", "",
        f"最近标签  {latest.get('tag') or '等待首条结果'}",
        f"浏览  {views.get('display') or '未取得'}    参与  {participation.get('display') or '未取得'}",
        f"近期速度  {chart}",
        f"最后错误  {error}", "",
        f"均速窗口：1 分钟已观测 {min(60,minute_age):.0f} 秒；5 分钟已观测 {min(300,five_age):.0f} 秒。",
        "仅采集标签头部；万／亿保留原文并标近似，不冒充精确计数。",
        "不同标签不相加；无法取得的统计保留为空，不当作 0。",
        "Ctrl+C 或关窗口仅退出监视器，LOFTER 与 Pixiv 继续采集。",
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / ".local")
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--once", action="store_true", help="显示一次后退出。")
    args = parser.parse_args()
    if args.interval < 1:
        parser.error("刷新间隔至少 1 秒。")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    interactive = sys.stdout.isatty() and not args.once
    if interactive and os.name == "nt":
        import ctypes
        handle = ctypes.windll.kernel32.GetStdHandle(-11)
        mode = ctypes.c_ulong()
        if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 4)
    history, calls, trend = deque(), deque(), deque(maxlen=36)
    initial = last_change = job_id = None
    if interactive:
        print("\x1b[2J\x1b[?25l", end="", flush=True)
    try:
        while True:
            started = time.monotonic()
            try:
                details = snapshot(args.directory)
                processed, _, job, _ = details
                if initial is None or job_id != job.get("id") or (history and processed < history[-1][1]):
                    history.clear(); calls.clear(); trend.clear()
                    initial, last_change, job_id = processed, started, job.get("id")
                if history and processed != history[-1][1]:
                    last_change = started
                history.append((started, processed))
                count = job.get("requests", 0)
                if calls and count < calls[-1][1]: calls.clear()
                calls.append((started, count))
                trend.append(rate(history, args.interval)[0])
                lines = render(history, calls, details, last_change, initial, args.interval, trend)
            except (OSError, sqlite3.Error, ValueError) as error:
                lines = ["LOFTER 标签监视器：暂时无法读取进度，将自动重试。", str(error)]
            if interactive:
                print("\x1b[H" + "\n".join(line + "\x1b[K" for line in lines) + "\x1b[J", end="", flush=True)
            else:
                print("\n".join(lines), flush=True)
            if args.once: break
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        if interactive: print("\x1b[?25h\n监视器已退出，采集任务保持原状。", flush=True)


if __name__ == "__main__":
    main()
