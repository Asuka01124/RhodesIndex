"""保存抖音 HTTP 会话；不启动浏览器，不代表话题统计已接通。"""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".local/python-libs"))

from tag_session import CollectError, LOCAL, load_cookies, protect


def parse_session_cookie(raw: str) -> dict:
    text = raw.strip()
    if not text:
        raise CollectError("输入为空，尚未保存。请粘贴后再按回车。")
    if any(ord(char) < 32 or ord(char) > 126 for char in text):
        raise CollectError("输入含换行、控制符或非英文字符。请只复制 Cookie 请求头的一行；终端可用 Ctrl+Shift+V 粘贴。")
    if text.lower().startswith("cookie:"):
        text = text[7:].strip()
    result = {}
    for part in text.split(";"):
        if not part.strip():
            continue
        name, separator, value = part.strip().partition("=")
        if not separator or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            raise CollectError("格式不正确，需要名称=值，以英文分号分隔；请勿复制整段请求头、cURL 命令或 Cookie 表格。")
        if name in result:
            raise CollectError("同一名称出现多次，请复制一个抖音请求的完整 Cookie 请求头。")
        # 保留请求头原生值，包括等号、引号和 JSON；不按 Set-Cookie 语法重解析。
        result[name] = value
    if not result:
        raise CollectError("未找到名称=值格式的 Cookie，尚未保存。")
    return result


def save_session(cookies: dict):
    encrypted = protect(json.dumps(cookies).encode())
    target = LOCAL / "http-sessions" / "douyin.dpapi"
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            file.write(encrypted)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true", help="只检查会话是否存在，不输出凭据")
    args = parser.parse_args(argv)
    if args.status:
        available = bool(load_cookies("douyin"))
        print("已保存本地抖音 HTTP 会话，尚需验证接口。" if available else "尚未保存本地抖音 HTTP 会话。")
        return 0 if available else 1
    if not sys.stdin.isatty():
        raise CollectError("请在本机交互终端运行，禁止通过命令参数或重定向传入 Cookie。")
    print("仅在此终端粘贴抖音请求的 Cookie 值（也接受 Cookie: 前缀）；输入不回显，不要发送到聊天。")
    print("建议用 Ctrl+Shift+V 或右键粘贴后按回车；格式错误可重试，Ctrl+C 取消。")
    while True:
        raw = getpass.getpass("douyin Cookie（输入隐藏，不回显）：")
        try:
            cookies = parse_session_cookie(raw)
        except CollectError as error:
            print(str(error))
            continue
        finally:
            del raw
        save_session(cookies)
        break
    print("凭据保存在被 Git 忽略的 .local/http-sessions/douyin.dpapi；尚未验证话题统计接口。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CollectError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except (KeyboardInterrupt, EOFError):
        print("已取消会话输入。", file=sys.stderr)
        raise SystemExit(130) from None
    except Exception:
        print("会话保存未完成，请检查本机终端和加密依赖；未输出凭据。", file=sys.stderr)
        raise SystemExit(1) from None
