"""纯 HTTP 会话与本机凭据；不导入、不启动浏览器。"""

from __future__ import annotations
import base64
import getpass
import hashlib
import json
import math
import os
import random
from pathlib import Path
import sqlite3
import threading
import time
from http.cookies import SimpleCookie

import requests

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
DOMAINS = {
    "pixiv": "pixiv.net",
    "bilibili": "bilibili.com",
    "xiaohongshu": "xiaohongshu.com",
    "youtube": "youtube.com",
    "bluesky": "bsky.app",
    "weibo": "weibo.com",
    "x": "x.com",
    "douyin": "douyin.com",
    "lofter": "lofter.com",
    "tumblr": "tumblr.com",
}


class CollectError(Exception):
    def __init__(self, message: str, kind: str = "failed"):
        super().__init__(message)
        self.kind = kind


def exact_count(value):
    if isinstance(value, str) and value.isascii() and value.isdigit():
        value = int(value)
    return value if type(value) is int and 0 <= value <= 9007199254740991 else None


def protect(data: bytes) -> bytes:
    if os.name != "nt":
        raise CollectError("当前加密会话存储使用 Windows 用户凭据保护。")
    import win32crypt

    return win32crypt.CryptProtectData(data, "罗德指数 HTTP 会话", None, None, None, 0)


def unprotect(data: bytes) -> bytes:
    import win32crypt

    return win32crypt.CryptUnprotectData(data, None, None, None, 0)[1]


def parse_cookie(header: str) -> dict:
    jar = SimpleCookie()
    jar.load(header.strip())
    return {key: value.value for key, value in jar.items()}


def store_session(platform: str):
    cookies = parse_cookie(getpass.getpass(f"{platform} Cookie（输入隐藏，不回显）："))
    if not cookies:
        raise CollectError("没有读取到有效 Cookie，未保存。")
    target = LOCAL / "http-sessions" / f"{platform}.dpapi"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(protect(json.dumps(cookies).encode()))
    print("会话已使用 Windows 当前用户凭据加密保存。")


def load_cookies(platform: str) -> dict:
    header = os.environ.get(f"RHODES_COOKIE_{platform.upper()}")
    if header:
        return parse_cookie(header)
    saved = LOCAL / "http-sessions" / f"{platform}.dpapi"
    if saved.exists():
        try:
            return json.loads(unprotect(saved.read_bytes()))
        except Exception:
            raise CollectError(
                "本机会话无法解密，请重新配置该平台的会话。", "blocked"
            ) from None
    profile = LOCAL / "browser-profiles" / platform
    state = profile / "Local State"
    database = profile / "Default" / "Network" / "Cookies"
    if not state.exists() or not database.exists() or os.name != "nt":
        return {}
    # 仅复用本项目先前获授权登录的配置；不扫描用户其他浏览器或账户。
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        encrypted_key = base64.b64decode(
            json.loads(state.read_text(encoding="utf-8"))["os_crypt"]["encrypted_key"]
        )
        key = unprotect(encrypted_key[5:])
        connection = sqlite3.connect(
            database.resolve().as_uri() + "?mode=ro", uri=True, timeout=3
        )
        try:
            rows = connection.execute(
                "SELECT host_key,name,value,encrypted_value,expires_utc FROM cookies"
            ).fetchall()
        finally:
            connection.close()
        result = {}
        for host, name, value, encrypted, expiry in rows:
            if not (
                host.lstrip(".") == DOMAINS[platform]
                or host.endswith("." + DOMAINS[platform])
            ):
                continue
            if expiry and expiry / 1e6 - 11644473600 <= time.time():
                continue
            if not value:
                blob = bytes(encrypted)
                if blob[:3] in (b"v10", b"v11"):
                    plain = AESGCM(key).decrypt(blob[3:15], blob[15:], None)
                    prefix = hashlib.sha256(host.encode()).digest()
                    if plain.startswith(prefix):
                        plain = plain[32:]
                    value = plain.decode()
                elif blob[:3] == b"v20":
                    raise CollectError(
                        "该登录配置采用应用绑定加密，请在本机隐藏输入 Cookie 一次。",
                        "blocked",
                    )
                elif blob:
                    value = unprotect(blob).decode()
            if value:
                result[name] = value
        return result
    except CollectError:
        raise
    except Exception:
        raise CollectError(
            "先前登录配置暂不可直接读取；请关闭该独立登录窗口，或在本机隐藏输入 Cookie。",
            "blocked",
        ) from None


def system_proxy() -> dict:
    if os.name != "nt" or os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"):
        return {}
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            if not winreg.QueryValueEx(key, "ProxyEnable")[0]:
                return {}
            raw = winreg.QueryValueEx(key, "ProxyServer")[0]
        if "=" not in raw:
            return {
                scheme: raw if "://" in raw else "http://" + raw
                for scheme in ["http", "https"]
            }
        return {
            scheme: address if "://" in address else "http://" + address
            for scheme, address in (part.split("=", 1) for part in raw.split(";"))
            if scheme in ("http", "https")
        }
    except OSError:
        return {}


class Session:
    """多线程采集的 HTTP 会话。

    requests.Session 不是线程安全的，连接池在并发下会串请求，
    因此每个线程各持一份 client，限速计时也各算各的。
    限流与服务端错误先指数退避重试，重试耗尽才上报，
    不把一次 429 当成整个平台被封。
    """

    BLOCKED = (401, 403, 406, 412, 461, 471)
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    }

    def __init__(self, platform: str, interval: float = 0.7, retries: int = 6):
        self.platform = platform
        self.interval = interval
        self.retries = max(1, retries)
        self.cookies = load_cookies(platform)
        self.proxies = system_proxy()
        self._local = threading.local()
        self._gate = threading.Lock()
        self._penalty_until = 0.0
        self.delay_range = None

    def set_random_delay(self, minimum, maximum):
        """每个线程在每次 HTTP 尝试前独立随机休眠，包括首次请求和重试。"""
        if not all(math.isfinite(v) for v in (minimum, maximum)) or not 0.2 <= minimum <= maximum:
            raise CollectError("随机休眠范围需为有限秒数，且 0.2 <= 最小值 <= 最大值。")
        self.delay_range = (minimum, maximum)

    def penalty(self, seconds: float):
        """全局限流闸门：一个线程发现被限流，所有线程一起等。

        各线程各自退避等于继续轮流敲接口，只会把惩罚期越拖越长。
        """
        with self._gate:
            self._penalty_until = max(
                self._penalty_until, time.monotonic() + max(0.0, seconds)
            )

    @property
    def client(self) -> requests.Session:
        client = getattr(self._local, "client", None)
        if client is None:
            client = requests.Session()
            client.proxies.update(self.proxies)
            for name, value in self.cookies.items():
                client.cookies.set(
                    name, value, domain="." + DOMAINS[self.platform], path="/"
                )
            client.headers.update(self.HEADERS)
            self._local.client = client
            self._local.last = 0.0
        return client

    def wait_for_penalty(self):
        while True:
            with self._gate:
                delay = self._penalty_until - time.monotonic()
            if delay <= 0:
                break
            time.sleep(min(delay, 5.0))

    def throttle(self):
        self.wait_for_penalty()
        if self.delay_range is not None:
            time.sleep(random.uniform(*self.delay_range))
            # 休眠期间其他线程可能发现限流，发请求前再次遵守共享冷却。
            self.wait_for_penalty()
        else:
            elapsed = time.monotonic() - self._local.last
            if elapsed < self.interval:
                time.sleep(self.interval - elapsed)
        self._local.last = time.monotonic()

    def request(self, method: str, url: str, **kwargs):
        client = self.client
        last = self.retries - 1
        for attempt in range(self.retries):
            self.throttle()
            try:
                response = client.request(method, url, timeout=(10, 30), **kwargs)
            except requests.RequestException:
                if attempt < last:
                    time.sleep(min(30.0, 2**attempt))
                    continue
                raise CollectError("HTTP 网络连接失败，断点已保留。") from None
            code = response.status_code
            if code in self.BLOCKED:
                response.close()
                raise CollectError(
                    f"HTTP {code}：会话、接口权限或验证受限；已停止该平台。", "blocked"
                )
            if code == 429 or code >= 500:
                response.close()
                if attempt < last:
                    backoff = min(30.0, 2**attempt)
                    if code == 429:
                        # 429 是整个会话被限流，退避要作用于全部线程。
                        self.penalty(backoff * 4)
                    else:
                        time.sleep(backoff)
                    continue
                raise CollectError(
                    f"HTTP {code}：限流或服务端错误，退避重试 {self.retries} 次仍失败；断点已保留。",
                    "blocked" if code == 429 else "failed",
                )
            if not response.ok:
                response.close()
                raise CollectError(f"HTTP {code}：作品或接口不可读取。")
            return response
        raise CollectError("HTTP 请求失败。")

    def json(self, method: str, url: str, **kwargs):
        response = self.request(method, url, **kwargs)
        try:
            return response.json()
        except ValueError:
            raise CollectError("接口未返回 JSON，未把错误页当作空列表。") from None
        finally:
            response.close()
