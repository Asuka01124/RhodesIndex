"""从本机只读实测证据生成中文报告，不发送平台请求。"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import statistics
from urllib.parse import urlsplit

from bilibili_interface_probe import NAMES
from pixiv_files import atomic_json


def analysis(directory):
    directory = Path(directory)
    rows = [json.loads(line) for line in (directory / 'observations.jsonl').read_text(encoding='utf-8').splitlines()]
    index = {row['case']: row for row in rows}
    if len(index) != len(rows):
        raise ValueError('用例标识重复，需先核查证据。')
    for name in NAMES:
        for case in ['tag/name/' + name, 'topic/search/bare/' + name, 'topic/search/prefixed/' + name]:
            if case not in index:
                raise ValueError('角色覆盖未完成：' + case)
    required = ['deep/page_size/50', 'deep/page_size/51', 'tag/batch/batch_ids',
                'audit/tag_top/page/300', 'audit/first/click', 'audit/first/stow', 'audit/wiki/batch_info']
    if any(case not in index for case in required):
        raise ValueError('关键协议用例尚未完成。')
    tags = [index['tag/name/' + name] for name in NAMES]
    tag_ok = [r for r in tags if r.get('code') == 0]
    bare, prefixed = {}, {}
    for name in NAMES:
        for mode in ['bare', 'prefixed']:
            entry = index['topic/search/' + mode + '/' + name]
            for topic in entry.get('data', {}).get('topics', []):
                if topic.get('name') == name:
                    bare[name] = topic
                if topic.get('name') == '明日方舟' + name:
                    prefixed[name] = topic
    endpoints = defaultdict(list)
    for row in rows:
        endpoints[row['endpoint']].append(row)
    endpoint_stats = []
    for url, entries in sorted(endpoints.items()):
        values = [r['networkSeconds'] for r in entries]
        endpoint_stats.append(dict(endpoint=url, requests=len(entries),
            medianNetworkSeconds=statistics.median(values),
            http=dict(Counter(str(r.get('httpStatus')) for r in entries)),
            codes=dict(Counter(str(r.get('code')) for r in entries))))
    capacity = []
    for size in [1, 20, 50, 51, 100, 200, 500, 1000]:
        r = index.get('deep/page_size/' + str(size), {})
        capacity.append(dict(requested=size, code=r.get('code'),
                             returned=r.get('data', {}).get('listSizes', {}).get('result')))
    tag_top = []
    for case, r in index.items():
        if not case.startswith('audit/tag_top/'):
            continue
        videos = r.get('data', {}).get('videos', [])
        dates = [v['pubdate'] for v in videos if type(v.get('pubdate')) is int]
        tag_top.append(dict(case=case, params=r['params'], http=r.get('httpStatus'), code=r.get('code'),
                            videos=len(videos), oldest=min(dates) if dates else None,
                            newest=max(dates) if dates else None,
                            uniqueIds=len({v['bvid'] for v in videos})))
    crosschecks = []
    selected = index['deep/page_size/20'].get('data', {}).get('videos', [])[:5]
    for video in selected:
        r = index.get('deep/crosscheck/detail/' + video['bvid'], {})
        metrics = r.get('data', {}).get('metrics', {})
        full = {key: metrics.get('View.stat.' + key) for key in ['view', 'like', 'favorite', 'reply', 'danmaku', 'coin', 'share']}
        expected = {key: video.get(source) for key, source in [
            ('view', 'play'), ('like', 'like'), ('favorite', 'favorites'), ('reply', 'review'), ('danmaku', 'video_review')]}
        search_tags = {t.strip() for t in (video.get('tag') or '').split(',') if t.strip()}
        native_tags = {t['tag_name'] for t in index.get('deep/crosscheck/tags/' + video['bvid'], {}).get('data', {}).get('tags', [])}
        crosschecks.append(dict(bvid=video['bvid'], searchMetrics=expected, detailMetrics=full,
                                searchTagCount=len(search_tags), nativeTagCount=len(native_tags),
                                sameNativeTags=bool(native_tags) and search_tags == native_tags,
                                nativeHasShu='黍' in native_tags))
    order_checks = []
    for order, field in [('click', 'play'), ('stow', 'favorites'), ('dm', 'video_review'),
                         ('scores', 'review'), ('like', 'like'), ('coin', 'coin')]:
        r = index.get('audit/order/' + order, {})
        videos = r.get('data', {}).get('videos', [])
        values = [v.get(field) for v in videos]
        valid = bool(values) and all(type(v) is int for v in values)
        order_checks.append(dict(order=order, field=field, code=r.get('code'),
                                 rows=len(videos), descending=valid and all(a >= b for a, b in zip(values, values[1:])),
                                 first=values[0] if values else None, firstBvid=videos[0]['bvid'] if videos else None))
    result = dict(requests=len(rows), distinctEndpoints=len(endpoints),
                  firstObservedAt=rows[0]['observedAt'], lastObservedAt=rows[-1]['observedAt'],
                  medianNetworkSeconds=statistics.median(r['networkSeconds'] for r in rows),
                  http429=sum(r.get('httpStatus') == 429 for r in rows),
                  restrictedResponses=sum(bool(r.get('familyStoppedAfterRestriction')) for r in rows),
                  roleNames=NAMES, roleTagSuccess=len(tag_ok),
                  roleTagFailures=[dict(name=r['params']['tag_name'], code=r.get('code')) for r in tags if r.get('code') != 0],
                  roleTagNonzeroViews=sum(r.get('data', {}).get('metrics', {}).get('count.view', 0) > 0 for r in tag_ok),
                  exactBareTopics=bare, exactPrefixedTopics=prefixed,
                  searchPageCapacity=capacity, tagTopTests=tag_top, videoCrosschecks=crosschecks,
                  sortedSearchChecks=order_checks, endpoints=endpoint_stats)
    atomic_json(directory / 'analysis.json', result)
    return result, index


def render(directory):
    directory = Path(directory)
    data, index = analysis(directory)
    beijing = timezone(timedelta(hours=8))
    def local(stamp):
        return datetime.fromisoformat(stamp).astimezone(beijing).strftime('%Y-%m-%d %H:%M:%S')
    lines = ['# B站快速统计接口实测记录', '',
             f'实测时间：{local(data["firstObservedAt"])} 至 {local(data["lastObservedAt"])}（北京时间）。', '',
             f'共 {data["requests"]} 个只读请求，{data["distinctEndpoints"]} 个地址，覆盖 {len(NAMES)} 个代表性名字。',
             '协议验证使用固定用例；没有生成截取样本冒充完整作品榜，也没有修改网站或生产采集数据库。',
             '本轮没有加载已登录的SESSDATA；未调用付费API。主动等待与网络耗时分别记录，固定请求间隔为3.5秒。', '',
             '## 可以直接读取的汇总', '',
             '| 对象 | 接口 | 可读数据 | 口径限制 |',
             '|---|---|---|---|',
             '| 视频TAG | `/x/tag/info` | `count.use`使用计数、`count.atten`关注数 | 单个原生标签；不是角色全站人数或视频总播放 |',
             '| 动态话题搜索 | `/x/topic/pub/search` | 精确匹配话题的阅读、讨论 | 返回模糊候选；不能盲取首项或把未匹配写成0 |',
             '| 动态话题详情 | `/x/topic/web/details/top` | 阅读、讨论、动态数，以及话题对象的收藏/点赞 | 收藏和点赞不是该话题全部帖子互动总和；不能当视频播放 |',
             '| 组合搜索 | `/x/web-interface/search/type` | 原生搜索结果数 | 大结果集触顶；时间切分需检查结果时间并继续细分 |', '',
             '## 角色覆盖', '',
             f'- {len(NAMES)} 个角色/形态名字中，{data["roleTagSuccess"]} 个视频TAG读取成功；失败：{data["roleTagFailures"]}。',
             f'- 成功TAG中，非零`count.view`为{data["roleTagNonzeroViews"]}个；本轮不能采用该字段作阅读榜。',
             f'- 每个名字分别检索裸名和“明日方舟＋名字”，各检查第一页候选；精确裸名话题匹配{len(data["exactBareTopics"])}个，精确前缀话题匹配{len(data["exactPrefixedTopics"])}个。',
             '- 这是已检查候选中的匹配覆盖，不是平台全话题不存在证明；部分查询有后续候选页。',
             '- 同名词、异格、联动的范围需另行约定，不把不同对象的计数混算。', '',
             '| 名字 | TAG使用数 | TAG关注数 |', '|---|---:|---:|']
    for name in NAMES:
        r = index['tag/name/' + name]
        metrics = r.get('data', {}).get('metrics', {})
        lines.append(f'| {name} | {metrics.get("count.use", "未取得")} | {metrics.get("count.atten", "未取得")} |')
    lines += ['', '## 搜索单页容量', '', '| 请求条数 | 返回码 | 实际条数 |', '|---:|---:|---:|']
    for row in data['searchPageCapacity']:
        lines.append(f'| {row["requested"]} | {row["code"]} | {row["returned"] if row["returned"] is not None else "未返回列表"} |')
    lines += ['', '搜索列表可同时提供播放、点赞、收藏、评论、弹幕、发布时间、UP主ID和原生标签字段；投币/分享需要检查其他接口。',
              '数据字段可用不等于一次得到角色总数。要累计全部视频互动，仍须处理翻页、触顶分段、BVID去重和覆盖范围。', '',
              '## 标签列表容量与分页', '', '| 用例 | 返回码 | 实际视频数 | 最早发布时间戳 | 最新发布时间戳 |', '|---|---:|---:|---:|---:|']
    for row in data['tagTopTests']:
        lines.append(f'| {row["case"]} | {row["code"]} | {row["videos"]} | {row["oldest"]} | {row["newest"]} |')
    lines += ['', '标签列表本身返回的stat可含完整七项互动；需根据实测页码范围核对它是否覆盖全部标签内容。不能把默认返回条数的合计叫全角色累计。', '',
              '## 视频字段交叉核对', '', '| BVID | 搜索播放/点赞/收藏 | 详情播放/点赞/收藏 | 标签一致 | 是否有原生“黍”标签 |', '|---|---|---|---|---|']
    for row in data['videoCrosschecks']:
        s, d = row['searchMetrics'], row['detailMetrics']
        lines.append(f'| {row["bvid"]} | {s["view"]}/{s["like"]}/{s["favorite"]} | {d["view"]}/{d["like"]}/{d["favorite"]} | {row["sameNativeTags"]} | {row["nativeHasShu"]} |')
    lines += ['', '跨请求快照可能有缓存/自然增长差异，数值差异不能强行抹平。组合词命中也不等于所有原生标签同时存在。', '',
              '## 排序能否用于读取首条指标', '', '| 排序参数 | 检查字段 | 返回码 | 20条是否降序 | 首条数值 |', '|---|---|---:|---|---:|']
    for row in data['sortedSearchChecks']:
        lines.append(f'| {row["order"]} | {row["field"]} | {row["code"]} | {row["descending"]} | {row["first"]} |')
    lines += ['', '即使排序有效，首条也是该搜索口径下的单条作品指标，不是累计播放、累计收藏或独立人数。', '',
              '## 每个地址的执行证据', '', '| 地址 | 请求数 | HTTP状态分布 | 业务码分布 | 网络耗时中位数（秒） |', '|---|---:|---|---|---:|']
    for row in data['endpoints']:
        lines.append(f'| `{row["endpoint"]}` | {row["requests"]} | {row["http"]} | {row["codes"]} | {row["medianNetworkSeconds"]:.3f} |')
    lines += ['', f'本轮HTTP429：{data["http429"]}次；识别为限制而停止该接口族：{data["restrictedResponses"]}次。',
              '失败/不支持/未核实不写成真实零值。一次成功不代表未来无限制，也不能由本轮结果宣称所有未测接口都不存在。', '',
              '## 复现与证据文件', '',
              '- `observations.jsonl`：逐请求的参数、公开来源、时间、状态、原生统计及字段结构。无Cookie、请求头或签名值。',
              '- `analysis.json`：角色覆盖、分页边界、视频交叉核对及排序检查。',
              '- `summary.json`、`job.json`：运行进度及接口族汇总。',
              '- 代码：`scripts/bilibili_interface_probe.py`、`scripts/bilibili_probe_report.py`。',
              '- 所有采集证据只保存在`.local/bilibili-interface-probe`，不上传GitHub、不部署。', '']
    (directory / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    result = render(args.directory)
    print(json.dumps({key: result[key] for key in ['requests', 'distinctEndpoints', 'medianNetworkSeconds', 'roleTagSuccess']}, ensure_ascii=False))
