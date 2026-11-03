"""组合关键词的原生搜索总数；触顶时分段读取小计，不翻页核验视频标签。"""

import hashlib
import json
import time
from urllib.parse import urlencode

from bilibili_tag_rules import rules_for, search_keyword
from collector_sources.base import now
from tag_session import CollectError, Session, exact_count


class BilibiliSearchTotals:
    endpoint = "https://api.bilibili.com/x/web-interface/search/type"
    count_basis = "search_result_total"
    reported_limit = 1000

    def __init__(self, operators, interval=3.5):
        self.operators = {operator["name"]: operator for operator in operators}
        self.session = Session("bilibili", interval, retries=2)
        self.requests = 0
        self.cancelled = lambda: False
        self.on_progress = lambda record: None

    def bind(self, store, run_id):
        self.store, self.run_id = store, run_id
        with store.lock:
            store.db.execute("""CREATE TABLE IF NOT EXISTS bilibili_search_progress(
                run_id TEXT,tag_key TEXT,data TEXT NOT NULL,PRIMARY KEY(run_id,tag_key))""")
            store.db.commit()

    def save(self, tag, state):
        with self.store.lock:
            try:
                self.store.db.execute("INSERT OR REPLACE INTO bilibili_search_progress VALUES(?,?,?)",
                                      (self.run_id, tag, json.dumps(state, ensure_ascii=False)))
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise

    def read(self, tag):
        query = search_keyword(rules_for(self.operators[tag]))
        digest = hashlib.sha256(query.encode()).hexdigest()
        with self.store.lock:
            row = self.store.db.execute("SELECT data FROM bilibili_search_progress WHERE run_id=? AND tag_key=?",
                                        (self.run_id, tag)).fetchone()
        state = json.loads(row[0]) if row else {
            "queryHash": digest, "windows": [[1, int(time.time())]],
            "windowCounts": [], "requests": 0, "observedAt": None, "truncated": False,
            "rootNumResults": None,
        }
        if state["queryHash"] != digest:
            raise CollectError("搜索关键词已变化，请新建批次，不能复用旧断点。")
        while state["windows"]:
            if self.cancelled():
                raise CollectError("已请求保存停止，搜索计数断点已保存。", "cancelled")
            lo, hi = state["windows"][0]
            params = {"search_type": "video", "keyword": query, "page": 1, "page_size": 1,
                      "order": "pubdate", "pubtime_begin_s": lo, "pubtime_end_s": hi}
            self.requests += 1
            body = self.session.json("GET", self.endpoint, params=params,
                                     headers={"Referer": "https://search.bilibili.com/"})
            code = body.get("code") if isinstance(body, dict) else None
            if code in (-101, -111, -352, -412, -509, -799):
                raise CollectError(f"B站搜索计数受限（代码 {code}），保存停止。", "blocked")
            data = body.get("data") if isinstance(body, dict) else None
            if type(code) is not int or code != 0 or not isinstance(data, dict):
                raise CollectError(f"B站搜索计数返回异常（代码 {code}），未写成零。")
            total = exact_count(data.get("numResults"))
            if total is None:
                raise CollectError("B站没有返回有效搜索总数，未根据列表长度猜测或补零。")
            rows = data.get("result") or []
            # 只检查首条记录的时间，确认接口确实应用了分段条件；不核验标签或逐条计数。
            if not isinstance(rows, list) or (total > 0 and not rows) or any(
                not isinstance(item, dict) or type(item.get("pubdate")) is not int
                or not lo <= item["pubdate"] <= hi for item in rows
            ):
                raise CollectError("搜索时间范围无法核实，已保留部分结果，不将重复计数相加。")
            if state["rootNumResults"] is None:
                state["rootNumResults"] = total
            state["requests"] += 1
            state["observedAt"] = now()
            if total >= self.reported_limit and hi > lo:
                # 初始跨度很大时优先切出最近4年，避免在1970年以来的空区间反复二分。
                mid = hi - 4 * 366 * 86400 if hi - lo > 8 * 366 * 86400 else (lo + hi) // 2
                state["windows"][:1] = [[mid + 1, hi], [lo, mid]]
            else:
                capped = total >= self.reported_limit
                state["truncated"] = state["truncated"] or capped
                state["windowCounts"].append({
                    "begin": lo, "end": hi, "numResults": data["numResults"], "value": total,
                    "capped": capped, "apiSourceUrl": self.endpoint + "?" + urlencode(params),
                    "observedAt": state["observedAt"],
                })
                state["windows"].pop(0)
            self.save(tag, state)
            self.on_progress(self.record(tag, query, state))
        return self.record(tag, query, state)

    def record(self, tag, query, state):
        total = sum(window["value"] for window in state["windowCounts"]) if state["windowCounts"] else None
        inconsistent = not state["windows"] and total is not None and total < state["rootNumResults"]
        complete = not state["windows"] and not state["truncated"] and not inconsistent
        return {
            "platform": "bilibili", "kind": "search_result_count", "countBasis": self.count_basis,
            "tag": tag, "nativeTag": tag, "workCount": total,
            "query": query, "searchTerms": [group[0] for group in rules_for(self.operators[tag])],
            "url": "https://search.bilibili.com/all?" + urlencode({"keyword": query}),
            "apiSourceUrl": self.endpoint + "?" + urlencode({"search_type": "video", "keyword": query}),
            "observedAt": state["observedAt"], "publishedAt": None, "year": None, "annualCounts": None,
            "nativeMetrics": {"rootNumResults": state["rootNumResults"], "windowCounts": state["windowCounts"]},
            "timeBasis": "all_time_at_observation", "aggregation": "sum_nonoverlapping_search_time_ranges",
            "complete": complete, "searchExhausted": not state["windows"],
            "lowerBound": total is not None and not complete, "truncated": state["truncated"],
            "countedWindows": len(state["windowCounts"]), "pendingWindows": len(state["windows"]),
            "status": "completed" if not state["windows"] else "collecting",
            "coverageNote": ("组合关键词的搜索结果数；触顶时按不重叠时间段汇总。不要求视频同时打齐标签，不代表全站总量。" if complete else
                             "组合搜索的部分累计结果，仍在读取分段或接口触顶；当前数量仅作下限。"),
        }
