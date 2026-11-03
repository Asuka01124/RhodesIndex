"""纯HTTP分页核验原生搜索标签；不把模糊搜索总数当作标签交集总量。"""

from datetime import datetime, timezone
import hashlib
import html
import json
import re
import time
from urllib.parse import urlencode

from bilibili_tag_rules import matches_tags, rules_for, search_keyword, search_keywords
from collector_sources.base import now
from tag_session import CollectError, Session, exact_count


class BilibiliIntersections:
    endpoint = "https://api.bilibili.com/x/web-interface/search/type"

    def __init__(self, operators, interval=3.5):
        self.operators = {o["name"]: o for o in operators}
        self.session = Session("bilibili", interval, retries=2)
        self.requests = 0
        self.cancelled = lambda: False
        self.on_progress = lambda record: None

    def bind(self, store, run_id):
        self.store, self.run_id = store, run_id
        with store.lock:
            store.db.executescript("""
                CREATE TABLE IF NOT EXISTS bilibili_intersection_progress(
                    run_id TEXT,tag_key TEXT,data TEXT NOT NULL,PRIMARY KEY(run_id,tag_key));
                CREATE TABLE IF NOT EXISTS bilibili_intersection_matches(
                    run_id TEXT,tag_key TEXT,bvid TEXT,data TEXT NOT NULL,PRIMARY KEY(run_id,tag_key,bvid));
            """)

    def read(self, tag):
        groups = rules_for(self.operators[tag])
        query = search_keyword(groups)
        digest = hashlib.sha256(json.dumps(groups, ensure_ascii=False).encode()).hexdigest()
        with self.store.lock:
            row = self.store.db.execute("SELECT data FROM bilibili_intersection_progress WHERE run_id=? AND tag_key=?",
                                        (self.run_id, tag)).fetchone()
        state = json.loads(row[0]) if row else {
            "rulesHash": digest, "windows": [[1, int(time.time())]], "page": 1,
            "scannedRows": 0, "rejectedRows": 0, "unverifiableRows": 0,
            "truncated": False, "lastPageHash": None, "observedAt": None,
        }
        if state["rulesHash"] != digest:
            raise CollectError("标签交集规则已变化，需要新一轮采集，不能复用旧断点。")
        state.setdefault("queryIndex", 0)
        state.setdefault("until", state["windows"][0][1] if state["windows"] else int(time.time()))
        # 旧版进行中的窗口没有候选去重清单，重读该窗口核对数量，已有匹配按BVID去重。
        if "windowIds" not in state:
            state.update(page=1, lastPageHash=None, windowIds=[], pageHashes=[], windowExpected=None)
        queries = search_keywords(groups)
        while state["windows"]:
            if self.cancelled():
                raise CollectError("已请求停止，交集统计及分页断点已保存。", "cancelled")
            lo, hi = state["windows"][0]
            page = state["page"]
            params = {"search_type": "video", "keyword": queries[state["queryIndex"]], "page": page,
                      "page_size": 50, "order": "pubdate", "pubtime_begin_s": lo, "pubtime_end_s": hi}
            self.requests += 1
            body = self.session.json("GET", self.endpoint, params=params,
                                     headers={"Referer": "https://search.bilibili.com/"})
            code = body.get("code") if isinstance(body, dict) else None
            if code in (-101, -111, -352, -412, -509, -799):
                raise CollectError(f"B站交集检索受限（代码 {code}），保存停止。", "blocked")
            data = body.get("data") if isinstance(body, dict) else None
            if code != 0 or not isinstance(data, dict):
                raise CollectError(f"B站交集检索返回异常（代码 {code}），未写成零。")
            total = exact_count(data.get("numResults"))
            pages = exact_count(data.get("numPages"))
            rows = data.get("result")
            if rows is None and total == 0:
                rows = []
            if total is None or pages is None or not isinstance(rows, list):
                raise CollectError("交集检索分页结构不可核验，未猜测数量。")
            if any(not isinstance(r, dict) or type(r.get("pubdate")) is not int
                   or not lo <= r["pubdate"] <= hi for r in rows):
                raise CollectError("B站发布时间筛选未生效，停止此标签；不将截断列表称为完整统计。")
            if page == 1 and total >= 1000 and hi > lo:
                mid = (lo + hi) // 2
                state["windows"][:1] = [[mid + 1, hi], [lo, mid]]
                state["lastPageHash"] = None
                state.update(windowIds=[], pageHashes=[], windowExpected=None)
                self.save(tag, state, [])
                continue
            if total >= 1000:
                state["truncated"] = True
            fingerprint = hashlib.sha256(json.dumps([r.get("bvid") for r in rows]).encode()).hexdigest()
            repeated = bool(rows and fingerprint in state["pageHashes"])
            if state["windowExpected"] is None:
                state["windowExpected"] = total
            elif state["windowExpected"] != total:
                state["truncated"] = True
            if repeated or (not rows and total > 0):
                state["truncated"] = True
            state["lastPageHash"] = fingerprint
            state["pageHashes"].append(fingerprint)
            window_ids = set(state["windowIds"])
            matched = []
            if not repeated:
                for r in rows:
                    state["scannedRows"] += 1
                    if isinstance(r.get("bvid"), str):
                        window_ids.add(r["bvid"])
                    if (not isinstance(r.get("tag"), str) or not isinstance(r.get("bvid"), str)
                            or not re.fullmatch(r"BV[0-9A-Za-z]+", r["bvid"])):
                        state["unverifiableRows"] += 1
                        continue
                    tags = [t.strip() for t in r["tag"].split(",") if t.strip()]
                    if not matches_tags(tags, groups):
                        state["rejectedRows"] += 1
                        continue
                    matched.append({
                        "id": r["bvid"], "platform": "bilibili", "tags": tags,
                        "title": html.unescape(re.sub(r"<[^>]*>", "", r.get("title") or "")),
                        "url": f"https://www.bilibili.com/video/{r['bvid']}/",
                        "publishedAt": datetime.fromtimestamp(r["pubdate"], timezone.utc).isoformat(),
                        "observedAt": now(), "matchBasis": "metadata_tag", "requiredTagGroups": groups,
                        "apiSourceUrl": self.endpoint + "?" + urlencode(params),
                        "nativeMetrics": {k: r.get(k) for k in ("play", "favorites", "review", "video_review")},
                    })
            state["observedAt"] = now()
            state["windowIds"] = sorted(window_ids)
            if repeated or not rows or page >= pages:
                if len(window_ids) < state["windowExpected"]:
                    state["truncated"] = True
                state["windows"].pop(0)
                state["page"] = 1
                state["lastPageHash"] = None
                state.update(windowIds=[], pageHashes=[], windowExpected=None)
            else:
                state["page"] += 1
            if not state["windows"] and state["queryIndex"] + 1 < len(queries):
                state["queryIndex"] += 1
                state["windows"] = [[1, state["until"]]]
            self.save(tag, state, matched)
            self.on_progress(self.record(tag, groups, query, state))
        return self.record(tag, groups, query, state)

    def save(self, tag, state, matched):
        with self.store.lock:
            try:
                for row in matched:
                    self.store.db.execute("INSERT OR REPLACE INTO bilibili_intersection_matches VALUES(?,?,?,?)",
                                          (self.run_id, tag, row["id"], json.dumps(row, ensure_ascii=False)))
                self.store.db.execute("INSERT OR REPLACE INTO bilibili_intersection_progress VALUES(?,?,?)",
                                      (self.run_id, tag, json.dumps(state, ensure_ascii=False)))
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise

    def record(self, tag, groups, query, state):
        with self.store.lock:
            count = self.store.db.execute("SELECT COUNT(*) FROM bilibili_intersection_matches WHERE run_id=? AND tag_key=?",
                                          (self.run_id, tag)).fetchone()[0]
        exhausted = not state["windows"]
        complete = exhausted and not state["truncated"] and not state["unverifiableRows"]
        value = count if state["observedAt"] and (not state["scannedRows"] or state["unverifiableRows"] < state["scannedRows"]) else None
        return {
            "platform": "bilibili", "kind": "tag_intersection_count", "tag": tag, "nativeTag": tag,
            "workCount": value,
            "requiredTagGroups": groups,
            "query": query, "countBasis": "exact_tag_intersection", "observedAt": state["observedAt"],
            "publishedAt": None, "year": None, "annualCounts": None,
            "url": "https://search.bilibili.com/all?" + urlencode({"keyword": query}),
            "apiSourceUrl": self.endpoint + "?" + urlencode({"search_type": "video", "keyword": query}),
            "timeBasis": "all_time_at_observation", "searchExhausted": exhausted,
            "complete": complete, "truncated": state["truncated"],
            "scannedRows": state["scannedRows"], "rejectedRows": state["rejectedRows"],
            "unverifiableRows": state["unverifiableRows"],
            "status": "unavailable" if exhausted and value is None else "completed" if exhausted else "collecting",
            "coverageNote": ("已遍历接口可返回的检索结果；不保证覆盖未被搜索索引收录的作品。" if complete else
                             "仅为已核验作品数；仍在采集或接口结果不完整，不能视为全站总量。"),
        }
