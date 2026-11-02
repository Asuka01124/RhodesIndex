"""在独立终端观察 Pixiv 入库速度；只读 SQLite，不发送平台请求。"""

from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import sys
import time


ROOT = Path(__file__).resolve().parents[1]


def snapshot(directory):
    # 不导入采集器，避免初始化 Cookie、运行锁或数据库迁移。
    uri = (directory / "http-collection.sqlite").resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=1) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        works = db.execute(
            "SELECT COUNT(*) FROM works WHERE key GLOB 'pixiv:*'"
        ).fetchone()[0]
        pending = db.execute(
            "SELECT COUNT(*) FROM metrics WHERE platform='pixiv'"
        ).fetchone()[0]
        states = {
            state: (count, pages or 0)
            for state, count, pages in db.execute(
                "SELECT state,COUNT(*),SUM(pages) FROM queries "
                "WHERE platform='pixiv' GROUP BY state"
            )
        }
    job_path = directory / "http-job.json"
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
        heartbeat = max(0, time.time() - job_path.stat().st_mtime)
    except (OSError, ValueError):
        job, heartbeat = {}, None
    return works, pending, states, job, heartbeat


def rate(history, seconds):
    latest = history[-1]
    cutoff = latest[0] - seconds
    base = history[0]
    for point in history:
        if point[0] > cutoff:
            break
        base = point
    elapsed = latest[0] - base[0]
    return (latest[1] - base[1]) / elapsed if elapsed > 0 else 0, elapsed


def render(history, details, last_change, initial, interval, trend):
    works, pending, states, job, heartbeat = details
    elapsed = history[-1][0] - history[-2][0] if len(history) > 1 else 0
    speed = (works - history[-2][1]) / elapsed if elapsed > 0 else 0
    minute, minute_age = rate(history, 60)
    five, five_age = rate(history, 300)
    average, age = rate(history, float("inf"))
    stale = max(0, history[-1][0] - last_change)
    delta = works - history[-2][1] if len(history) > 1 else 0
    status = {
        "running": "运行中", "completed": "已结束", "failed": "有未完成项",
        "cancelled": "已停止",
    }.get(job.get("state"), "未知")
    if heartbeat is None:
        status += " / 无法读取任务心跳"
    elif heartbeat > 20:
        status += f" / 心跳已 {heartbeat:.0f} 秒未更新，需核实采集进程"
    elif stale >= 30 and job.get("state") == "running":
        status += " / 暂无新作品，可能在退避或处理重复、空标签"
    levels = "▁▂▃▄▅▆▇█"
    maximum = max(trend, default=0)
    chart = "".join(levels[min(7, int(s / maximum * 7))] if maximum else "▁" for s in trend)
    lines = [
        "PIXIV 采集速度监视器",
        "=" * 66,
        f"更新时间  {datetime.now():%Y-%m-%d %H:%M:%S}    每 {interval:g} 秒刷新",
        f"任务状态  {status}",
        "",
        f"当前速度     {speed:9.2f} 件/秒     {speed * 60:9.0f} 件/分钟",
        f"近 1 分钟    {minute:9.2f} 件/秒     {minute * 60:9.0f} 件/分钟",
        f"近 5 分钟    {five:9.2f} 件/秒     {five * 3600:9.0f} 件/小时",
        f"观察期均速   {average:9.2f} 件/秒     已观察 {age / 60:.1f} 分钟",
        "",
        f"累计 Pixiv 作品     {works:,} 件（平台作品 ID 去重）",
        f"本次监视期间新增    {works - initial:+,} 件",
        f"本轮新增            {delta:+,} 件 / {elapsed:.1f} 秒",
        f"距离上次新增        {stale:.0f} 秒",
        f"指标待处理队列      {pending:,} 件",
        "",
        f"近期速度趋势  {chart}   峰值 {maximum:.1f} 件/秒",
        f"标签查询：结束 {states.get('exhausted', (0, 0))[0]:,}  "
        f"受阻 {states.get('blocked', (0, 0))[0]:,}  "
        f"受限 {states.get('restricted', (0, 0))[0]:,}  "
        f"失败 {states.get('failed', (0, 0))[0]:,}",
        f"查询记录中已处理页数：{sum(pages for _, pages in states.values()):,}",
        f"当前处理：{str(job.get('current') or '等待任务更新')[:90]}",
        "",
        f"均速窗口：1 分钟已观测 {min(60, minute_age):.0f} 秒；"
        f"5 分钟已观测 {min(300, five_age):.0f} 秒。",
        "速度统计的是新入库作品，不是 HTTP 请求数；0 速不一定是限流。",
        "指标阶段可能没有新作品入库，请同时观察待处理队列。",
        "只读监视，不发送网络请求。Ctrl+C 或关窗口仅退出监视器。",
    ]
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / ".local")
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--once", action="store_true", help="输出一次后退出。")
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
    history, trend = deque(), deque(maxlen=36)
    initial = last_change = None
    if interactive:
        print("\x1b[2J\x1b[?25l", end="", flush=True)
    try:
        while True:
            started = time.monotonic()
            try:
                details = snapshot(args.directory)
                works = details[0]
                if initial is None:
                    initial, last_change = works, started
                if history and works != history[-1][1]:
                    last_change = started
                if history and works < history[-1][1]:
                    history.clear()
                    trend.clear()
                    initial = works
                history.append((started, works))
                trend.append(rate(history, args.interval)[0])
                # 观察期均速保留完整样本，每 5 秒一条，持续一天约 1.7 万条。
                lines = render(history, details, last_change, initial, args.interval, trend)
            except (sqlite3.Error, OSError) as error:
                lines = ["Pixiv 速度监视器：暂时无法读取数据库，将自动重试。", str(error)]
            if interactive:
                print("\x1b[H" + "\n".join(line + "\x1b[K" for line in lines) + "\x1b[J", end="", flush=True)
            else:
                print("\n".join(lines), flush=True)
            if args.once:
                break
            time.sleep(max(0, args.interval - (time.monotonic() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        if interactive:
            print("\x1b[?25h\n监视器已退出，采集任务保持原状。", flush=True)


if __name__ == "__main__":
    main()
