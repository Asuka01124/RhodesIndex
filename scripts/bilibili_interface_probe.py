"""只读实测B站快速统计接口；证据仅存本机私有目录，不改生产数据。"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import time
from urllib.parse import urlencode, urlsplit

import requests

from pixiv_files import atomic_json
from tag_session import LOCAL, Session

NAMES = [
    '黍', '阿米娅', '凯尔希', '斯卡蒂', '德克萨斯', '拉普兰德', '能天使', '银灰',
    '令', '夕', '年', '望', '林', '陈', '山', '黑', '红', '空', 'W', 'Mon3tr',
    '爱丽丝', '医生', '铃兰', '迷迭香', '夜莺', '送葬人', '多萝西', '伊芙利特',
    '缄默德克萨斯', '阿米娅(医疗)', '丰川祥子', '玛露西尔', '莱欧斯', '灰烬',
    '艾拉', '九色鹿', '罗小黑', 'Friston-3', 'GALLUS²', '泰拉大陆调查团',
]
NUMERIC_FIELDS = {
    'view', 'play', 'favorite', 'favorites', 'coin', 'coins', 'like', 'likes', 'hates',
    'reply', 'review', 'video_review', 'danmaku', 'share', 'fans', 'atten', 'use',
    'dynamics', 'discuss', 'count', 'total', 'numResults', 'numPages', 'page', 'pagesize',
    'archive_count', 'attention', 'rank_score', 'ctime', 'pubdate', 'duration',
    'counter', 'views', 'pageviews', 'hits', 'visits', 'length', 'pageid',
}
BLOCK_CODES = {-352, -412, -509, -799}


def now():
    return datetime.now(timezone.utc).isoformat()


def describe(data):
    """仅保存公开统计、公开作品ID和字段结构；不保存Cookie、头、签名或账户资料。"""
    result = dict(fields=sorted(data) if isinstance(data, dict) else [], scalars={},
                  metrics={}, listSizes={}, videos=[], topics=[], dynamicStats=[], tags=[], schema={})
    videos, topics, dynamics, tags = {}, {}, {}, {}

    def walk(value, path='', depth=0):
        if depth > 7:
            return
        if isinstance(value, dict):
            if value.get('tag_id') and isinstance(value.get('tag_name'), str):
                tags[str(value['tag_id'])] = {k: value[k] for k in ['tag_id', 'tag_name', 'count', 'likes', 'hates'] if k in value}
            if value.get('bvid'):
                fields = {k: value[k] for k in ['id', 'aid', 'bvid', 'title', 'pubdate', 'created',
                           'play', 'favorites', 'review', 'video_review', 'like', 'mid', 'tag', 'hit_columns'] if k in value}
                fields['availableFields'] = sorted(value)
                if isinstance(value.get('stat'), dict):
                    fields['stat'] = {k: v for k, v in value['stat'].items() if k in NUMERIC_FIELDS}
                if isinstance(value.get('tags'), list):
                    fields['tags'] = value['tags']
                videos[str(value['bvid'])] = {**videos.get(str(value['bvid']), {}), **fields}
            if isinstance(value.get('modules'), dict) and isinstance(value['modules'].get('module_stat'), dict):
                stats = value['modules']['module_stat']
                dynamics[str(value.get('id_str', value.get('id', path)))] = {
                    k: v.get('count') for k, v in stats.items() if isinstance(v, dict) and 'count' in v}
            if isinstance(value.get('name'), str) and value.get('id') is not None and any(k in value for k in ['view', 'discuss', 'dynamics']):
                topics[str(value['id'])] = {k: value[k] for k in ['id', 'name', 'view', 'discuss',
                    'dynamics', 'fav', 'like', 'share', 'show_interact_data', 'ctime', 'jump_url'] if k in value}
            for key, item in value.items():
                child = path + '.' + key if path else key
                result['schema'][child] = type(item).__name__
                if key in NUMERIC_FIELDS and type(item) in (int, float, bool) and '[]' not in child:
                    result['metrics'][child] = item
                if depth == 0 and key in ['tag_id', 'tag_name', 'aid', 'bvid', 'state', 'type', 'show_interact_data']:
                    result['scalars'][key] = item
                if isinstance(item, list):
                    result['listSizes'][child] = len(item)
                if isinstance(item, dict):
                    walk(item, child, depth + 1)
                elif key == 'card' and isinstance(item, str) and item.startswith('{'):
                    try:
                        walk(json.loads(item), child, depth + 1)
                    except ValueError:
                        pass
                elif isinstance(item, list):
                    for row in item:
                        if isinstance(row, dict):
                            walk(row, child + '[]', depth + 1)
        elif isinstance(value, list):
            result['listSizes'][path or 'data'] = len(value)
            for item in value:
                walk(item, path + '[]', depth + 1)
    walk(data)
    result['videos'] = list(videos.values())
    result['topics'] = list(topics.values())
    result['dynamicStats'] = list(dynamics.values())
    result['tags'] = list(tags.values())
    if isinstance(data, dict) and isinstance(data.get('Tags'), list):
        result['videoTags'] = [item.get('tag_name') for item in data['Tags'] if isinstance(item, dict)]
    if isinstance(data, dict) and isinstance(data.get('page_info'), dict):
        result['pageInfo'] = {k: v for k, v in data['page_info'].items() if k in ['offset', 'has_more', 'total']}
    return result


class Probe:
    def __init__(self, directory, interval=3.5):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'observations.jsonl'
        self.entries = [json.loads(line) for line in self.path.read_text(encoding='utf-8').splitlines()] if self.path.exists() else []
        self.done = {e['case']: e for e in self.entries}
        self.session = Session('bilibili', interval=0, retries=1)
        self.interval = interval
        self.next_at = 0
        self.last_body = None
        self.blocked_families = set()
        self.wbi_mix = None
        self.job = dict(state='running', startedAt=now(), phase=None, requests=0,
                       hasSavedLogin=bool(self.session.cookies.get('SESSDATA')),
                       intervalSeconds=interval, productionDataChanged=False)

    def status(self, **values):
        self.job.update(values, updatedAt=now(), completedCases=len(self.entries))
        atomic_json(self.directory / 'job.json', self.job)

    def request(self, family, case, url, params=None, *, signed=False):
        if case in self.done:
            return self.done[case]
        if self.job.get('state') == 'cooldown_required':
            return None
        if family in self.blocked_families:
            return None
        assert url.startswith(('https://api.bilibili.com/', 'https://app.bilibili.com/',
                               'https://s.search.bilibili.com/', 'https://wiki.biligame.com/',
                               'https://www.bilibili.com/'))
        params = params or {}
        public_params = {k: v for k, v in params.items() if k not in ['w_rid', 'wts']}
        self.status(currentCase=case, family=family)
        delay = max(0, self.next_at - time.monotonic())
        if delay:
            time.sleep(delay)
        entry = dict(case=case, family=family, endpoint=url, params=public_params,
                     signed=signed, observedAt=now(), waitSeconds=round(delay, 4),
                     sourceUrl=url + ('?' + urlencode(public_params) if public_params else ''))
        started = time.monotonic()
        self.last_body = None
        self.job['requests'] += 1
        try:
            response = self.session.client.get(url, params=params,
                headers={'Referer': 'https://www.bilibili.com/'}, timeout=(10, 25), allow_redirects=False)
            entry.update(httpStatus=response.status_code, bytes=len(response.content))
            try:
                body = response.json()
            except ValueError:
                body = None
            if isinstance(body, dict):
                self.last_body = body
                entry['code'] = body.get('code')
                entry['responseKeys'] = sorted(body)
                if family == 'bootstrap':
                    entry['data'] = {'hasWbiKeys': bool((body.get('data') or {}).get('wbi_img'))}
                else:
                    entry['data'] = describe(body.get('data', body))
            else:
                entry['format'] = 'non_json'
            if response.status_code == 429:
                entry['retryAfter'] = response.headers.get('Retry-After')
                self.status(state='cooldown_required', reason='HTTP429')
                self.blocked_families.update(['tag', 'topic_search', 'topic_detail', 'search', 'video', 'legacy', 'bootstrap'])
            elif response.status_code in (403, 412) or entry.get('code') in BLOCK_CODES:
                self.blocked_families.add(family)
                entry['familyStoppedAfterRestriction'] = True
            response.close()
        except requests.RequestException as error:
            entry['networkError'] = type(error).__name__
        entry['networkSeconds'] = round(time.monotonic() - started, 4)
        entry['observedAt'] = now()
        self.next_at = time.monotonic() + self.interval
        with self.path.open('a', encoding='utf-8') as file:
            file.write(json.dumps(entry, ensure_ascii=False) + '\n')
        self.entries.append(entry)
        self.done[case] = entry
        self.status()
        if len(self.entries) % 10 == 0 or entry.get('familyStoppedAfterRestriction'):
            print(json.dumps(dict(cases=len(self.entries), case=case, http=entry.get('httpStatus'),
                                  code=entry.get('code'), seconds=entry['networkSeconds']), ensure_ascii=False), flush=True)
        return entry

    def inventory(self):
        self.status(phase='tag_inventory', plannedNames=NAMES)
        for name in NAMES + ['明日方舟', '明日方舟黍', 'CodexProbe_NoSuchTag_20261107']:
            self.request('tag', 'tag/name/' + name, 'https://api.bilibili.com/x/tag/info', {'tag_name': name})
        self.status(phase='topic_inventory')
        for name in NAMES:
            for label, keyword in [('bare', name), ('prefixed', '明日方舟' + name)]:
                self.request('topic_search', 'topic/search/' + label + '/' + name,
                    'https://api.bilibili.com/x/topic/pub/search', {'keywords': keyword, 'page_size': 20, 'page_num': 1})
        self.status(phase='topic_details')
        found = {}
        for entry in self.entries:
            if entry['family'] != 'topic_search' or entry.get('code') != 0:
                continue
            for topic in entry.get('data', {}).get('topics', []):
                if topic['name'] in NAMES or topic['name'] in ['明日方舟' + n for n in NAMES]:
                    found[topic['id']] = topic
        for identifier, topic in found.items():
            self.request('topic_detail', 'topic/detail/' + str(identifier),
                'https://app.bilibili.com/x/topic/web/details/top', {'topic_id': identifier})
        self.report()

    def capabilities(self):
        self.request('bootstrap', 'bootstrap/homepage', 'https://www.bilibili.com/')
        self.wbi_cases()
        self.status(phase='tag_routes')
        for name in ['黍', '阿米娅', '明日方舟']:
            entry = self.request('tag', 'tag/name/' + name, 'https://api.bilibili.com/x/tag/info', {'tag_name': name})
            identifier = (entry or {}).get('data', {}).get('scalars', {}).get('tag_id')
            if not identifier:
                continue
            for label, route, params in [
                ('by_id', '/x/tag/info', {'tag_id': identifier}),
                ('detail', '/x/tag/detail', {'tag_id': identifier, 'pn': 1, 'ps': 20}),
                ('ranking', '/x/tag/detail/ranking', {'tag_id': identifier}),
                ('top', '/x/tag/top', {'tid': identifier}),
                ('similar', '/x/tag/change/similar', {'tag_id': identifier}),
                ('tag_top', '/x/web-interface/tag/top', {'tid': identifier}),
            ]:
                self.request('legacy', f'tag/route/{label}/{name}', 'https://api.bilibili.com' + route, params)
        for label, route, params in [
            ('batch_ids', '/x/tag/infos', {'tag_ids': '16401450,5433094'}),
            ('combined_names', '/x/tag/info', {'tag_name': '黍,阿米娅'}),
            ('plural_ids', '/x/tag/info', {'tag_ids': '16401450,5433094'}),
        ]:
            self.request('legacy', 'tag/batch/' + label, 'https://api.bilibili.com' + route, params)
        for name in ['黍', '阿米娅']:
            for year in [2024, 2025]:
                self.request('legacy', f'tag/date/{name}/{year}', 'https://api.bilibili.com/x/tag/info',
                             {'tag_name': name, 'scd': f'{year}-01-01', 'ecd': f'{year}-12-31'})
        self.status(phase='search_routes')
        for name in ['黍', '阿米娅', '爱丽丝', 'W', '丰川祥子']:
            for query in [name, name + ' 明日方舟']:
                self.search_case('video', query, 'pubdate', 1)
        for kind in ['topic', 'article', 'photo', 'bili_user']:
            for query in ['黍', '阿米娅', '明日方舟 黍']:
                self.search_case(kind, query, 'totalrank', 1)
        for size in [1, 20, 50, 100]:
            self.search_case('video', '黍 明日方舟', 'pubdate', size)
        for order in ['totalrank', 'click', 'stow', 'dm']:
            self.search_case('video', '黍 明日方舟', order, 20)
        for name in ['黍', '阿米娅']:
            for year in [2023, 2024, 2025, 2026]:
                zone = timezone(timedelta(hours=8))
                lo = int(datetime(year, 1, 1, tzinfo=zone).timestamp())
                hi = int(datetime(year + 1, 1, 1, tzinfo=zone).timestamp()) - 1
                self.search_case('video', name + ' 明日方舟', 'pubdate', 20, lo=lo, hi=hi)
        for query in ['黍 明日方舟', '阿米娅 明日方舟']:
            self.request('search', 'search/all/' + query, 'https://api.bilibili.com/x/web-interface/search/all/v2', {'keyword': query, 'page': 1})
        self.status(phase='video_metrics')
        found = {}
        for entry in self.entries:
            for video in entry.get('data', {}).get('videos', []):
                if video.get('bvid'):
                    found[video['bvid']] = video
        for bvid in ['BV1sH4y1a7P2', 'BV1tv421i7GH']:
            found.setdefault(bvid, {'bvid': bvid})
        # 这是接口协议验证的固定案例，不是按角色截取样本生成作品榜。
        selected = list(found.values())[:5]
        for item in selected:
            for route in ['archive/stat', 'view', 'view/detail']:
                result = self.request('video', 'video/' + route + '/' + item['bvid'],
                    'https://api.bilibili.com/x/web-interface/' + route, {'bvid': item['bvid']})
                if route == 'archive/stat':
                    native_aid = (result or {}).get('data', {}).get('scalars', {}).get('aid')
                    if native_aid:
                        item['aid'] = native_aid
        if len(selected) >= 2:
            for key in ['bvid', 'aid']:
                if not all(v.get(key) for v in selected[:2]):
                    continue
                self.request('video', 'video/batch/' + key, 'https://api.bilibili.com/x/web-interface/archive/stat',
                             {key: ','.join(str(v[key]) for v in selected[:2])})
        for keyword in ['黍', '明日方舟黍']:
            self.request('search', 'suggest/' + keyword, 'https://s.search.bilibili.com/main/suggest',
                         {'term': keyword, 'main_ver': 'v1', 'func': 'suggest'})
        self.status(phase='topic_detail_routes')
        for topic_id in [1154297, 1140775]:
            self.request('topic_detail', 'topic/host/api/' + str(topic_id),
                         'https://api.bilibili.com/x/topic/web/details/top', {'topic_id': topic_id})
            self.request('topic_detail', 'topic/cards/' + str(topic_id),
                         'https://app.bilibili.com/x/topic/web/details/cards',
                         {'topic_id': topic_id, 'page_size': 3, 'sort_by': 2, 'source': 'Web'})
        for year in [2024, 2025]:
            self.request('topic_detail', 'topic/date/' + str(year),
                         'https://app.bilibili.com/x/topic/web/details/top',
                         {'topic_id': 1154297, 'start_time': f'{year}-01-01', 'end_time': f'{year}-12-31'})
        self.request('topic_search', 'topic/negative/control', 'https://api.bilibili.com/x/topic/pub/search',
                     {'keywords': 'CodexProbe_NoSuchTopic_20261107', 'page_size': 20, 'page_num': 1})
        self.report()

    def wbi_cases(self):
        self.status(phase='signed_search')
        self.request('bootstrap', 'bootstrap/nav', 'https://api.bilibili.com/x/web-interface/nav')
        image = ((self.last_body or {}).get('data') or {}).get('wbi_img') or {}
        if not image.get('img_url') or not image.get('sub_url'):
            self.status(wbiKeysAvailable=False)
            return
        key = ''.join(urlsplit(image[k]).path.rsplit('/', 1)[-1].split('.')[0] for k in ['img_url', 'sub_url'])
        permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,
                       37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
        if len(key) < 64:
            self.status(wbiKeysAvailable=False)
            return
        mix = ''.join(key[i] for i in permutation)[:32]
        self.wbi_mix = mix
        self.status(wbiKeysAvailable=True)
        for query in ['黍 明日方舟', '阿米娅 明日方舟']:
            for variant in ['unsigned', 'signed']:
                params = dict(search_type='video', keyword=query, order='pubdate', page=1, page_size=20)
                if variant == 'signed':
                    params = self.sign_params(params)
                self.request('wbi_' + variant, 'search/wbi/' + variant + '/' + query,
                    'https://api.bilibili.com/x/web-interface/wbi/search/type', params, signed=variant == 'signed')

    def sign_params(self, params):
        params = {**params, 'wts': int(time.time())}
        params = {k: ''.join(c for c in str(v) if c not in "!'()*") for k, v in params.items()}
        encoded = urlencode(sorted(params.items()))
        params['w_rid'] = hashlib.md5((encoded + self.wbi_mix).encode()).hexdigest()
        return params

    def search_case(self, kind, query, order, size, *, lo=None, hi=None):
        params = dict(search_type=kind, keyword=query, page=1, page_size=size, order=order)
        if lo is not None:
            params.update(pubtime_begin_s=lo, pubtime_end_s=hi)
        case = 'search/' + json.dumps(params, ensure_ascii=False, sort_keys=True)
        if 'search' in self.blocked_families and self.wbi_mix:
            return self.request('wbi_signed', case + '/wbi',
                'https://api.bilibili.com/x/web-interface/wbi/search/type', self.sign_params(params), signed=True)
        return self.request('search', case, 'https://api.bilibili.com/x/web-interface/search/type', params)

    def deep_checks(self):
        self.status(phase='page_capacity_and_field_audit')
        for size in [1, 20, 50, 51, 100, 200, 500, 1000]:
            self.request('search', 'deep/page_size/' + str(size),
                         'https://api.bilibili.com/x/web-interface/search/type',
                         dict(search_type='video', keyword='黍 明日方舟', order='click', page=1, page_size=size))
        for parameter, threshold in [('min_play', 100000), ('min_favorite', 10000)]:
            self.request('search', 'deep/threshold/' + parameter,
                         'https://api.bilibili.com/x/web-interface/search/type',
                         dict(search_type='video', keyword='黍 明日方舟', order='pubdate', page=1, page_size=20,
                              **{parameter: threshold}))
        self.request('search', 'deep/invalid_search_type', 'https://api.bilibili.com/x/web-interface/search/type',
                     dict(search_type='codex_invalid_type', keyword='黍', page=1, page_size=1))
        self.status(phase='crosscheck_search_metrics')
        first = self.done.get('deep/page_size/20') or {}
        selected = first.get('data', {}).get('videos', [])[:5]
        for video in selected:
            bvid = video['bvid']
            for label, route in [('stat', 'x/web-interface/archive/stat'), ('detail', 'x/web-interface/view/detail'),
                                 ('tags', 'x/tag/archive/tags')]:
                self.request('video', 'deep/crosscheck/' + label + '/' + bvid,
                             'https://api.bilibili.com/' + route, {'bvid': bvid})
        self.status(phase='topic_public_counts_semantics')
        for topic_id in [1154297, 1140775]:
            self.request('topic_detail', 'deep/topic/detail/' + str(topic_id),
                         'https://app.bilibili.com/x/topic/web/details/top', {'topic_id': topic_id})
            self.request('topic_detail', 'deep/topic/cards/' + str(topic_id),
                         'https://app.bilibili.com/x/topic/web/details/cards',
                         {'topic_id': topic_id, 'page_size': 3, 'sort_by': 2, 'source': 'Web'})
        for name, identifier in [('黍', 16401450), ('阿米娅', 5433094)]:
            for label, route, params in [
                ('detail_large', '/x/tag/detail', {'tag_id': identifier, 'pn': 1, 'ps': 100}),
                ('detail_next', '/x/tag/detail', {'tag_id': identifier, 'pn': 2, 'ps': 20}),
                ('tag_top_recheck', '/x/web-interface/tag/top', {'tid': identifier}),
                ('tag_top_next', '/x/web-interface/tag/top', {'tid': identifier, 'pn': 2, 'ps': 100}),
                ('similar_recheck', '/x/tag/change/similar', {'tag_id': identifier}),
                ('detail_old_year', '/x/tag/detail', {'tag_id': identifier, 'pn': 1, 'ps': 20,
                                                     'pubtime_begin_s': 1672502400, 'pubtime_end_s': 1704038399}),
            ]:
                self.request('legacy', 'deep/tag/' + label + '/' + name, 'https://api.bilibili.com' + route, params)
            top = self.done.get('deep/tag/tag_top_recheck/' + name) or {}
            for video in top.get('data', {}).get('videos', [])[:2]:
                self.request('video', 'deep/tag/membership/' + name + '/' + video['bvid'],
                             'https://api.bilibili.com/x/tag/archive/tags', {'bvid': video['bvid']})
        self.status(phase='wiki_batch_counts')
        self.request('wiki', 'deep/wiki/batch_info', 'https://wiki.biligame.com/arknights/api.php',
                     {'action': 'query', 'prop': 'info', 'titles': '黍|阿米娅|凯尔希', 'format': 'json'})
        self.request('wiki', 'deep/wiki/pageviews', 'https://wiki.biligame.com/arknights/api.php',
                     {'action': 'query', 'prop': 'pageviews', 'titles': '黍|阿米娅', 'format': 'json'})
        self.report()

    def report(self):
        families = {}
        for entry in self.entries:
            group = families.setdefault(entry['family'], dict(requests=0, successful=0, codes={}, times=[]))
            group['requests'] += 1
            group['successful'] += entry.get('httpStatus') == 200 and entry.get('code') == 0
            code = str(entry.get('code', entry.get('httpStatus', entry.get('networkError'))))
            group['codes'][code] = group['codes'].get(code, 0) + 1
            group['times'].append(entry['networkSeconds'])
        for group in families.values():
            values = sorted(group.pop('times'))
            group['medianNetworkSeconds'] = round(statistics.median(values), 4)
            group['p95NetworkSeconds'] = values[max(0, math.ceil(len(values)*0.95)-1)]
        atomic_json(self.directory / 'summary.json', dict(generatedAt=now(), requests=len(self.entries), families=families))
        if self.job.get('state') != 'cooldown_required':
            self.status(state='phase_completed')

    def audit(self):
        self.status(phase='tag_list_capacity_and_bounds')
        for size in [1, 20, 100, 101, 200, 1000]:
            self.request('legacy', 'audit/tag_top/size/' + str(size),
                         'https://api.bilibili.com/x/web-interface/tag/top', {'tid': 16401450, 'pn': 1, 'ps': size})
        for page in [3, 10, 20, 50, 100, 200, 300]:
            self.request('legacy', 'audit/tag_top/page/' + str(page),
                         'https://api.bilibili.com/x/web-interface/tag/top', {'tid': 16401450, 'pn': page, 'ps': 100})
        self.request('legacy', 'audit/tag_top/old_year',
                     'https://api.bilibili.com/x/web-interface/tag/top',
                     {'tid': 16401450, 'pn': 1, 'ps': 100, 'pubtime_begin_s': 1672502400, 'pubtime_end_s': 1704038399})
        self.status(phase='video_parameter_compatibility')
        selected = (self.done.get('deep/page_size/20') or {}).get('data', {}).get('videos', [])[:2]
        for video in selected:
            for label, route, params in [
                ('archive_stat_aid', 'archive/stat', {'aid': video['aid']}),
                ('archive_stat_jsonp', 'archive/stat', {'aid': video['aid'], 'jsonp': 'jsonp'}),
                ('view_aid', 'view', {'aid': video['aid']}),
            ]:
                self.request('video', 'audit/video/' + label + '/' + video['bvid'],
                             'https://api.bilibili.com/x/web-interface/' + route, params)
        self.status(phase='single_query_maximum_metrics')
        for order in ['click', 'stow', 'dm', 'scores', 'like', 'coin']:
            self.request('search', 'audit/order/' + order, 'https://api.bilibili.com/x/web-interface/search/type',
                         {'search_type': 'video', 'keyword': '黍 明日方舟', 'order': order, 'page': 1, 'page_size': 20})
        for order in ['click', 'stow', 'scores']:
            self.request('search', 'audit/first/' + order, 'https://api.bilibili.com/x/web-interface/search/type',
                         {'search_type': 'video', 'keyword': '黍 明日方舟', 'order': order, 'page': 1, 'page_size': 1})
        for query in ['CodexProbe_NoSuchCharacter_20261107', '明日方舟 CodexProbe_NoSuchCharacter_20261107']:
            self.request('search', 'audit/negative/search/' + query, 'https://api.bilibili.com/x/web-interface/search/type',
                         {'search_type': 'video', 'keyword': query, 'order': 'pubdate', 'page': 1, 'page_size': 1})
        self.request('topic_search', 'audit/negative/topic_prefix', 'https://api.bilibili.com/x/topic/pub/search',
                     {'keywords': '明日方舟CodexProbe_NoSuchCharacter_20261107', 'page_size': 20, 'page_num': 1})
        self.request('wiki', 'audit/wiki/batch_info', 'https://wiki.biligame.com/arknights/api.php',
                     {'action': 'query', 'prop': 'info', 'titles': '黍|阿米娅|凯尔希', 'format': 'json'})
        self.report()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['inventory', 'capabilities', 'deep', 'audit', 'all', 'report'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--interval', type=float, default=3.5)
    args = parser.parse_args()
    if args.interval < 1 or not math.isfinite(args.interval):
        parser.error('只读探测间隔至少1秒。')
    probe = Probe(args.directory, args.interval)
    if args.phase in ['inventory', 'all']:
        probe.inventory()
    if args.phase in ['capabilities', 'all']:
        probe.capabilities()
    if args.phase in ['deep', 'all']:
        probe.deep_checks()
    if args.phase in ['audit', 'all']:
        probe.audit()
    probe.report()
    print(json.dumps(dict(directory=str(args.directory), cases=len(probe.entries)), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
