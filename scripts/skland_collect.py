"""采集森空岛干员话题的原生累计统计，输出仅供罗德指数本地读取。"""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import hmac
from html import unescape
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
import time
import unicodedata
from urllib.parse import urlsplit

import requests


SITE = "https://www.skland.com"
API = "https://zonai.skland.com"
INDEX = "https://wiki.biligame.com/arknights/森空岛话题简介"
FIELDS = ("viewNum", "publishNum", "discussionNum")
MAX_SAFE_INTEGER = 2**53 - 1
ALIASES = {"PhonoR-0": "PhonoR-O"}
SHARED_TOPICS = {"阿米娅(医疗)": "阿米娅", "阿米娅(近卫)": "阿米娅"}


class CollectionError(Exception):
    """一次读取失败。"""


class AccessLimited(CollectionError):
    """访客会话受限，停止当前批次。"""


def normalize(name):
    return unicodedata.normalize("NFKC", name).strip().casefold()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def native_count(value):
    if type(value) is int or (
        isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value)
    ):
        count = int(value)
        if 0 <= count <= MAX_SAFE_INTEGER:
            return count
    return None


def publication_time(value):
    stamp = native_count(value)
    if stamp:
        try:
            return datetime.fromtimestamp(stamp, timezone.utc).isoformat(timespec="seconds")
        except (OverflowError, OSError, ValueError):
            pass
    return None


def topic_index(session):
    response = session.get(INDEX, timeout=20)
    response.raise_for_status()
    index = defaultdict(set)
    rows = re.findall(
        r"<tr[^>]*>\s*<th[^>]*>\s*(\d+)\s*</th>\s*<td[^>]*>(.*?)</td>",
        response.content.decode("utf-8"),
        re.S,
    )
    for topic_id, name in rows:
        index[normalize(unescape(re.sub(r"<[^>]*>", "", name)))].add(int(topic_id))
    if not index:
        raise CollectionError("公开话题索引没有返回可识别的记录。")
    return index


class Skland:
    def __init__(self, session, interval):
        self.session = session
        self.interval = interval
        self.next_request = 0.0
        self.clock_offset = 0
        self.secret = None

    def get(self, path, params=None, *, signed=True):
        request = self.session.prepare_request(requests.Request("GET", API + path, params=params))
        for attempt in range(3):
            time.sleep(max(0, self.next_request - time.monotonic()))
            self.next_request = time.monotonic() + self.interval
            timestamp = str(int(time.time()) + self.clock_offset)
            headers = {"platform": "3", "timestamp": timestamp, "dId": "", "vName": "1.0.0"}
            request.headers.update({key: value for key, value in headers.items() if value})
            if signed:
                url = urlsplit(request.url)
                message = url.path + url.query + timestamp + json.dumps(headers, separators=(",", ":"))
                digest = hmac.new(self.secret, message.encode(), hashlib.sha256).hexdigest()
                request.headers["sign"] = hashlib.md5(digest.encode()).hexdigest()
            try:
                response = self.session.send(request, timeout=12, allow_redirects=False)
                if response.status_code >= 500 and attempt < 2:
                    continue
                return response
            except requests.RequestException as error:
                if attempt == 2:
                    raise CollectionError("森空岛网络请求失败。") from error

    def refresh(self):
        response = self.get("/web/v1/auth/refresh", signed=False)
        try:
            payload = response.json()
            token = payload["data"]["token"]
            clock = int(payload["timestamp"])
            if response.status_code != 200 or payload["code"] != 0 or not isinstance(token, str) or not token:
                raise ValueError
        except (ValueError, KeyError, TypeError) as error:
            raise AccessLimited(f"访客会话初始化失败（HTTP {response.status_code}）。") from error
        self.secret = token.encode()
        self.clock_offset = clock - int(time.time())

    def data(self, path, params):
        response = self.get(path, params)
        if response.status_code == 401:
            self.refresh()
            response = self.get(path, params)
        if response.status_code in (401, 403, 429):
            raise AccessLimited(f"访客请求受限（HTTP {response.status_code}）。")
        try:
            payload = response.json()
        except ValueError as error:
            raise CollectionError(f"森空岛未返回 JSON（HTTP {response.status_code}）。") from error
        if response.status_code != 200 or not isinstance(payload, dict) or payload.get("code") != 0:
            raise CollectionError(f"森空岛接口返回异常（HTTP {response.status_code}）。")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise CollectionError("森空岛响应缺少统计结构。")
        return data

    def topic(self, topic_id):
        return self.data("/web/v1/tag", {"id": topic_id}).get("tagAgg")

    def search(self, name):
        candidates = set()
        cursor = ""
        seen = {cursor}
        while True:
            data = self.data("/web/v1/search/tag", {"keyword": name, "pageToken": cursor, "pageSize": 10})
            items = data.get("list")
            if not isinstance(items, list) or type(data.get("hasMore")) is not bool:
                raise CollectionError("话题搜索返回了未知的分页结构。")
            for item in items:
                tag = item.get("tag") if isinstance(item, dict) else None
                if not isinstance(tag, dict) or not isinstance(tag.get("name"), str):
                    raise CollectionError("话题搜索返回了无法核验的结果。")
                topic_id = native_count(tag.get("id"))
                if topic_id and tag.get("kind") == 1 and normalize(tag["name"]) == normalize(name):
                    candidates.add(topic_id)
            if not data["hasMore"]:
                return candidates
            cursor = data.get("pageToken")
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise CollectionError("话题搜索未返回可继续的分页游标。")
            seen.add(cursor)


def pending(operator):
    return {
        "operatorId": operator["id"],
        "operatorName": operator["name"],
        "status": "pending",
        "topicId": None,
        "topicName": None,
        "sourceUrl": None,
        "publishedAt": None,
        "observedAt": None,
        "nativeMetrics": dict.fromkeys(FIELDS),
        "missingReason": "等待采集。",
    }


def verified_topic(client, cache, topic_id, name):
    if topic_id not in cache:
        aggregate = client.topic(topic_id)
        if not isinstance(aggregate, dict) or not isinstance(aggregate.get("tag"), dict):
            raise CollectionError("话题详情缺少平台标识。")
        cache[topic_id] = (aggregate, utc_now())
    aggregate, observed = cache[topic_id]
    tag = aggregate["tag"]
    actual = tag.get("name")
    if (
        tag.get("id") != topic_id
        or tag.get("kind") != 1
        or not isinstance(actual, str)
        or normalize(actual) != normalize(name)
    ):
        return None
    stats = aggregate.get("tagRts")
    counts = {key: native_count(stats.get(key)) if isinstance(stats, dict) else None for key in FIELDS}
    available = sum(value is not None for value in counts.values())
    return {
        "status": "ok" if available == len(FIELDS) else "partial" if available else "unavailable",
        "topicId": topic_id,
        "topicName": actual,
        "sourceUrl": f"{SITE}/tag?id={topic_id}",
        "publishedAt": publication_time(tag.get("publishAtTs")),
        "observedAt": observed,
        "nativeMetrics": counts,
        "missingReason": None if available == len(FIELDS) else "平台未提供全部原生指标。",
    }


def collect_operator(client, index, cache, operator):
    row = pending(operator)
    name = operator["name"]
    lookup = ALIASES.get(name, name)
    candidates = index.get(normalize(lookup), set())
    if len(candidates) == 1:
        result = verified_topic(client, cache, next(iter(candidates)), lookup)
        if result:
            return {**row, **result}
    candidates = client.search(lookup)
    if not candidates and name in SHARED_TOPICS:
        lookup = SHARED_TOPICS[name]
        candidates = index.get(normalize(lookup), set())
    if len(candidates) == 1:
        result = verified_topic(client, cache, next(iter(candidates)), lookup)
        if result:
            return {**row, **result}
    reason = "存在多个同名候选，需核对角色归属。" if len(candidates) > 1 else "未找到可核验的角色话题。"
    return {**row, "status": "unmatched", "missingReason": reason}


def save_snapshot(path, records):
    metadata = {
        "platform": "skland",
        "schemaVersion": 1,
        "timeBasis": "all_time_at_observation",
        "totalOperators": len(records),
        "matchedOperators": sum(row["topicId"] is not None for row in records),
        "available": {
            key: sum(row["nativeMetrics"][key] is not None for row in records) for key in FIELDS
        },
        "generatedAt": utc_now(),
    }
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump({"metadata": metadata, "records": records}, handle, ensure_ascii=False)
            handle.write("\n")
        for attempt in range(4):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 3:
                    raise
                time.sleep(0.1 * (attempt + 1))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return metadata


def run(args):
    workspace = args.workspace.resolve()
    path = workspace / ".local/skland/topic-counts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with (path.parent / "collector.lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt

                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise CollectionError("已有森空岛采集进程正在使用这个本地目录。") from error
        return collect(args, workspace, path)


def collect(args, workspace, path):
    operators = json.loads((workspace / "public/data/operators.json").read_text(encoding="utf-8-sig"))
    records = [pending(operator) for operator in operators]
    if not records or len({row["operatorId"] for row in records}) != len(records):
        raise CollectionError("本地干员名单为空或包含重复 ID。")
    if args.resume and path.is_file():
        previous = json.loads(path.read_text(encoding="utf-8"))
        if previous.get("metadata", {}).get("schemaVersion") != 1:
            raise CollectionError("本地快照版本不匹配，无法续采。")
        previous_rows = {row["operatorId"]: row for row in previous["records"]}
        for position, row in enumerate(records):
            old = previous_rows.get(row["operatorId"])
            if old and old["operatorName"] == row["operatorName"] and old["status"] in ("ok", "unmatched"):
                records[position] = old

    with requests.Session() as session:
        session.headers.update({"Origin": SITE, "Referer": SITE + "/", "Accept": "application/json"})
        index = topic_index(session)
        client = Skland(session, args.interval)
        client.refresh()
        cache = {}
        interrupted = False
        completed = 0
        try:
            for position, operator in enumerate(operators):
                if records[position]["status"] != "pending":
                    continue
                try:
                    records[position] = collect_operator(client, index, cache, operator)
                except AccessLimited as error:
                    records[position].update(status="blocked", missingReason=str(error))
                    print(error, flush=True)
                    interrupted = True
                    break
                except CollectionError as error:
                    records[position].update(status="failed", missingReason=str(error))
                completed += 1
                if completed % 25 == 0:
                    save_snapshot(path, records)
                    print(f"已处理 {position + 1}/{len(records)} 条干员档案。", flush=True)
        except KeyboardInterrupt:
            interrupted = True
        finally:
            metadata = save_snapshot(path, records)
        statuses = {status: sum(row["status"] == status for row in records) for status in sorted({row["status"] for row in records})}
        print(f"已保存本地快照：{metadata['matchedOperators']}/{len(records)} 条匹配，状态 {statuses}", flush=True)
        return 2 if interrupted or any(statuses.get(key) for key in ("failed", "partial", "unavailable")) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd(), help="罗德指数网站目录")
    parser.add_argument("--resume", action="store_true", help="继续上次采集，保留成功和已查无匹配的记录")
    parser.add_argument("--interval", type=float, default=0.4, help="请求间隔秒数，最低 0.3 秒")
    args = parser.parse_args()
    if not 0.3 <= args.interval < float("inf"):
        parser.error("--interval 必须是至少 0.3 的有限数值。")
    try:
        return run(args)
    except (CollectionError, requests.RequestException, OSError, ValueError, KeyError) as error:
        print(f"采集无法继续：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
