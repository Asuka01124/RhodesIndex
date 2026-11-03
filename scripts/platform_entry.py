"""各平台独立 CLI 的兼容桥接，沿用旧数据库、运行锁、控制文件和断点键。"""

from __future__ import annotations

import sys

from tag_collect import main
from tag_session import CollectError, LOCAL


def run(platform, argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        args = ["--help"]
    if platform == "bilibili":
        from bilibili_collect import main as count_main
        return count_main(args)
    if args[0] == "collect":
        # 默认接续；不允许用独立入口悄悄切到另一个平台。
        if any(a == "--platforms" or a.startswith("--platforms=") for a in args):
            raise CollectError("平台独立入口不接受 --platforms，请使用对应平台的脚本。")
        args += ["--platforms", platform]
        if "--resume" not in args:
            args.append("--resume")
    elif args[0] == "session":
        if any(a == "--platform" or a.startswith("--platform=") for a in args):
            raise CollectError("此入口已固定平台，保存会话时无需传 --platform。")
        args += ["--platform", platform]
    return main(args)


def entry(platform):
    try:
        run(platform)
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception as error:
        print(
            f"采集未完成（{type(error).__name__}）；已保存断点，请查看本地任务状态。",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
