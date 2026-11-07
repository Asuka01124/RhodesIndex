"""单角色原生 TAG 快查；本体和异格按标签使用次数合并，不冒充去重作品数。"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlencode

from collector_sources.base import now
from collector_sources.bilibili_counts import BilibiliCounts
from lofter_tag_stats import TagStatsCollector, TagStatsStore
from tag_session import CollectError, LOCAL, ROOT, exact_count
from tag_store import atomic_json


RULE = "bilibili_single_character_tag_use_v1"
KEY_PREFIX = "single_tag_v1:"
RUNTIME = LOCAL / "bilibili"
WEBSITE_ROOT = Path("D:/RhodesIndex")

# 明确维护形态归属，不能靠名字相似或数字后缀猜测（维什戴尔、维娜、酒神等会漏）。
FORM_BASE_IDS = {
    "char_1001_amiya2": "char_002_amiya",
    "char_1011_lava2": "char_121_lava",
    "char_1012_skadi2": "char_263_skadi",
    "char_1013_chen2": "char_010_chen",
    "char_1014_nearl2": "char_148_nearl",
    "char_1015_aglna2": "char_291_aglina",
    "char_1016_agoat2": "char_180_amgoat",
    "char_1019_siege2": "char_112_siege",
    "char_1020_reed2": "char_261_sddrag",
    "char_1021_kroos2": "char_124_kroos",
    "char_1022_flwr2": "char_181_flower",
    "char_1023_ghost2": "char_143_ghost",
    "char_1024_hbisc2": "char_120_hibisc",
    "char_1026_gvial2": "char_187_ccheal",
    "char_1027_greyy2": "char_253_greyy",
    "char_1028_texas2": "char_102_texas",
    "char_1029_yato2": "char_502_nblade",
    "char_1030_noirc2": "char_500_noirc",
    "char_1031_slent2": "char_108_silent",
    "char_1032_excu2": "char_279_excu",
    "char_1033_swire2": "char_308_swire",
    "char_1034_jesca2": "char_235_jesica",
    "char_1035_wisdel": "char_113_cqbw",
    "char_1036_fang2": "char_123_fang",
    "char_1037_amiya3": "char_002_amiya",
    "char_1038_whitw2": "char_140_whitew",
    "char_1039_thorn2": "char_293_thorns",
    "char_1040_blaze2": "char_017_huang",
    "char_1041_angel2": "char_103_angel",
    "char_1042_phatm2": "char_250_phatom",
    "char_1043_leizi2": "char_306_leizi",
    "char_1044_hsgma2": "char_136_hsguma",
    "char_1045_svash2": "char_172_svrash",
    "char_1046_sbell2": "char_174_slbell",
    "char_1047_halo2": "char_135_halo",
    "char_1048_orchd2": "char_278_orchid",
    "char_1049_catap2": "char_282_catap",
    "char_1050_chen3": "char_010_chen",
    "char_1051_headb2": "char_115_headbr",
    "char_1052_kalts2": "char_003_kalts",
}


def character_groups(roster):
    index = {o["id"]: o for o in roster}
    groups = {}
    for operator in roster:
        base_id = FORM_BASE_IDS.get(operator["id"], operator["id"])
        if base_id not in index:
            raise ValueError(f"本体档案缺失：{base_id}")
        groups.setdefault(base_id, []).append(operator)
    return [(index[base], sorted(forms, key=lambda o: (o["id"] != base, o["id"])))
            for base, forms in groups.items()]


def make_plan(operators):
    plan = {}
    for operator in operators:
        tag = operator["name"]
        item = plan.setdefault(tag, {"key": KEY_PREFIX + tag, "tag": tag,
                                    "operatorIds": [], "scope": RULE})
        item["operatorIds"].append(operator["id"])
    return list(plan.values())


class SingleTagSource(BilibiliCounts):
    def read(self, tag):
        try:
            row = super().read(tag)
        except CollectError as error:
            if error.kind != "unavailable":
                raise
            row = {"platform": "bilibili", "kind": "tag_count", "tag": tag,
                   "nativeTag": tag, "tagId": None, "workCount": None,
                   "status": "unavailable", "missingReason": str(error),
                   "observedAt": now(), "publishedAt": None, "nativeMetrics": {},
                   "url": None, "apiSourceUrl": self.endpoint + "?" + urlencode({"tag_name": tag})}
        return {**row, "rule": RULE, "countBasis": "native_tag_use"}


def count_snapshot(root=ROOT, website_root=WEBSITE_ROOT):
    root, website_root = Path(root), Path(website_root)
    roster = json.loads((website_root / "public/data/operators.json").read_text(encoding="utf-8"))
    saved, queue = {}, {}
    try:
        job = json.loads((root / ".local/bilibili/http-job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        job = {}
    path = root / ".local/http-collection.sqlite"
    if path.exists():
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as db:
            db.execute("BEGIN")
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "bilibili_tag_stats" in tables:
                saved = dict(db.execute("SELECT tag_key,data FROM bilibili_tag_stats WHERE tag_key LIKE 'single_tag_v1:%'"))
            if "bilibili_tag_queue" in tables and job.get("kind") == RULE:
                queue = {tag: (state, note) for tag, state, note in db.execute(
                    "SELECT tag_key,state,note FROM bilibili_tag_queue WHERE run_id=?", (job.get("id"),))}
    records, tag_records = [], {}
    for base, forms in character_groups(roster):
        components = []
        for form in forms:
            tag, oid = form["name"], form["id"]
            if tag in {r["tag"] for r in components}:
                continue
            key = KEY_PREFIX + tag
            row = json.loads(saved.get(key, "{}"))
            valid = (row.get("rule") == RULE and row.get("countBasis") == "native_tag_use"
                     and row.get("tag") == tag and oid in row.get("operatorIds", []))
            if not valid:
                row = {}
            count = exact_count(row.get("workCount"))
            state, note = queue.get(key, ("pending", "尚未采集这个单角色 TAG。"))
            component = {
                "tag": tag, "nativeTag": row.get("nativeTag", tag), "tagId": row.get("tagId"),
                "workCount": count, "status": row.get("status", state),
                "observedAt": row.get("observedAt"), "publishedAt": None,
                "url": row.get("url"), "apiSourceUrl": row.get("apiSourceUrl") or
                BilibiliCounts.endpoint + "?" + urlencode({"tag_name": tag}),
                "nativeMetrics": row.get("nativeMetrics", {}),
                "missingReason": None if count is not None else row.get("missingReason", note),
                "updateError": note if count is not None and state in ("failed", "blocked") else None,
            }
            components.append(component)
            tag_records[tag] = component
        available = [r for r in components if r["workCount"] is not None]
        complete = len(available) == len(components)
        count = sum(r["workCount"] for r in available) if available else None
        records.append({
            "operatorId": base["id"], "sharedOperatorIds": [o["id"] for o in forms],
            "tag": base["name"], "nativeTag": base["name"], "tagId": components[0]["tagId"],
            "workCount": count, "status": "completed" if complete else "partial" if available else "pending",
            "countBasis": "native_tag_use_sum", "rule": RULE, "components": components,
            "query": None, "searchTerms": [r["tag"] for r in components],
            "complete": complete, "lowerBound": bool(available) and not complete,
            "observedAt": max((r["observedAt"] for r in available), default=None),
            "url": components[0]["url"], "apiSourceUrl": components[0]["apiSourceUrl"],
            "missingReason": None if available else "尚未取得本角色的单 TAG 统计。",
            "coverageNote": (f"已取得 {len(available)}/{len(components)} 个形态 TAG。"
                             "合计为标签使用次数，同一视频使用多个形态标签会重复计入；不是去重作品总数。"),
        })
    available_tags = sum(r["workCount"] is not None for r in tag_records.values())
    return {"schemaVersion": 1, "kind": "tag_count", "platform": "bilibili", "records": records,
            "metadata": {
                "plannedTags": len(tag_records), "availableTags": available_tags,
                "missingTags": len(tag_records) - available_tags, "plannedCharacters": len(records),
                "availableCharacters": sum(r["workCount"] is not None for r in records),
                "coverage": "configured_tags" if available_tags == len(tag_records) else "partial",
                "generatedAt": max((r["observedAt"] for r in records if r["observedAt"]), default=None),
                "timeBasis": "all_time_at_observation", "countBasis": "native_tag_use_sum", "rule": RULE,
                "methodology": "仅查询中文角色主名 TAG，不加明日方舟或联动作品名。读取 count.use，"
                               "本体与异格按同一角色合并并累加各 TAG 使用数；跨 TAG 未去重。"
                               "同名内容可能混入；缺失留空，不补零；不提供年份或累计播放量。"}}


def export_counts(root=ROOT, website_root=WEBSITE_ROOT):
    data = count_snapshot(root, website_root)
    atomic_json(Path(root) / ".local/bilibili/tag-counts.json", data)
    atomic_json(Path(website_root) / "public/data/bilibili-tag-counts.json", data)
    return data


class BilibiliSingleTagCollector(TagStatsCollector):
    kind = RULE
    label = "哔哩哔哩单 TAG"

    def __init__(self, operators, *, interval=1.5, resume=True, store=None, source=None,
                 runtime=RUNTIME, website_root=WEBSITE_ROOT):
        self.website_root = Path(website_root)
        super().__init__(operators, workers=1, interval=interval, resume=resume,
                         store=store if store is not None else TagStatsStore(platform="bilibili"),
                         source=source if source is not None else SingleTagSource(interval),
                         runtime=runtime, plan=make_plan(operators))

    def publish(self):
        super().publish()
        if self.store.directory == LOCAL and self.runtime == RUNTIME:
            signature = (self.job["state"], self.job["processedTags"], str(self.job.get("errors", [])[-1:]))
            if signature != getattr(self, "_exported_signature", None):
                export_counts(website_root=self.website_root)
                self._exported_signature = signature
