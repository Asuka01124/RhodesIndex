# 分平台采集器

所有命令在 `D:\RhodesIndex` 下运行。只使用纯 HTTP，不依赖 Vite，不部署。凭据继续使用已有的 DPAPI 加密会话或明确的环境变量引用。

## 文件划分

| 平台     | 独立入口                         | 接口实现                                          |
| -------- | -------------------------------- | ------------------------------------------------- |
| Pixiv    | `scripts/pixiv_collect.py`       | `scripts/collector_sources/pixiv.py`              |
| 哔哩哔哩 | `scripts/bilibili_collect.py`    | `scripts/collector_sources/bilibili.py`           |
| 小红书   | `scripts/xiaohongshu_collect.py` | `scripts/collector_sources/xiaohongshu_topics.py` |
| YouTube  | `scripts/youtube_collect.py`     | `scripts/collector_sources/youtube.py`            |
| Bluesky  | `scripts/bluesky_collect.py`     | `scripts/collector_sources/bluesky.py`            |
| Tumblr   | `scripts/tumblr_collect.py`      | `scripts/collector_sources/tumblr.py`             |
| LOFTER   | `scripts/lofter_collect.py`      | `scripts/collector_sources/lofter_tags.py`        |

微博使用独立的话题汇总入口，X仍没有作品采集适配器。抖音已接通独立的话题汇总试采，尚未接入逐作品采集或网站。

抖音浏览器登录不会自动同步为 HTTP 会话。可在本机交互终端运行 `python -X utf8 scripts/douyin_session.py`，将抖音页面请求中的 Cookie 值隐藏输入并用 Windows DPAPI 加密保存；不要发送到聊天、写入命令参数或日志。也可在用户授权的独立登录窗口内提取该窗口的抖音 Cookie，经仅绑定本机回环的一次性接收器直接加密保存，不落明文状态文件。`python -X utf8 scripts/douyin_session.py --status` 仅显示会话是否存在，不显示凭据；DPAPI必须由同一Windows用户读取。

## 小红书话题浏览量

```powershell
python -X utf8 scripts/xiaohongshu_collect.py probe --operators 阿米娅,爱丽丝,黍
python -X utf8 scripts/xiaohongshu_collect.py collect
python -X utf8 scripts/xiaohongshu_collect.py status
python -X utf8 scripts/xiaohongshu_collect.py stop
```

默认精确匹配角色本名；仅 `character_topic_rules.py` 中 `PREFIXED_NAMES` 的角色匹配「明日方舟＋角色名」。阿米娅的三个职业形态共用 `#阿米娅`。候选未命中、同名歧义或缺失指标时留空。每位角色统计一个话题的原生累计浏览量 `view_num`，保留话题 ID、来源及采集时间。小红书排行通过本地接口 `/api/xiaohongshu/tag-counts` 读取快照。

默认单线程，请求间隔至少 3.5 秒。同范围的未完成批次可接续，`--refresh` 新建批次。访问受限时保存断点。快照存于 `.local/xiaohongshu/topic-counts.json`。旧的逐作品入口可用 `works` 子命令访问，例如 `python -X utf8 scripts/xiaohongshu_collect.py works --help`。

## 微博话题原创人数

```powershell
python -X utf8 scripts/weibo_collect.py probe 阿米娅 黍 明日方舟爱丽丝
python -X utf8 scripts/weibo_collect.py collect --operators 阿米娅,爱丽丝,黍
python -X utf8 scripts/weibo_collect.py collect
python -X utf8 scripts/weibo_collect.py status
python -X utf8 scripts/weibo_collect.py stop
```

每个话题读取一次微博公开详情页，保存原创人数、讨论次数、阅读次数和采集时间。显示为万或亿的数值保留原文和单独的约数估值。话题与小红书共用 `character_topic_rules.py` 的名单，默认使用角色本名，74 个容易撞名的角色加「明日方舟」。阿米娅各职业形态共用 `阿米娅`，434 个档案对应 432 个话题。该口径只适合比较干员之间的相对热度，只覆盖实际使用选定话题的内容，不等于微博全站总量；缺失保留为空。

默认单线程，请求至少间隔3.5秒。同范围的未完成批次可从断点继续，`--refresh` 新建批次。访问重定向、登录验证或限流时保存并暂停。快照存于 `.local/weibo/topic-counts.json`，可用 `status` 查看同一批次进度。

## 抖音话题汇总试采

```powershell
python -X utf8 scripts/douyin_collect.py probe --tag 阿尔图罗
python -X utf8 scripts/douyin_collect.py collect --interval 3.5 --resume
python -X utf8 scripts/douyin_collect.py status
python -X utf8 scripts/douyin_collect.py stop
python -X utf8 scripts/douyin_collect.py export
python -X utf8 scripts/douyin_collect.py session-status
```

试采只请求 `https://creator.douyin.com/aweme/v1/search/challengesug/`，参数为 `keyword`、`source=challenge_create`、`aid=2906`，使用已有加密会话、最小3.5秒间隔；不请求会返回验证码的搜索HTML页面。接口路径参考 [OpenCLI 话题接口修复](https://github.com/jackwener/OpenCLI/pull/2254)，已用纯HTTP实际验证成功。不导入或依赖浏览器进行统计采集；遇到验证、重定向或业务错误停止。

原生 `view_count` 保存为话题累计播放量，不能当作作品数、参与人数或独立热度指数。保留精确话题名、话题ID、原生字段、API来源和采集时间；`publishedAt`为null，因为汇总数据没有作品发布时间。同名之外的建议单独保留，不相加；同名不同ID视为歧义。接口只返回固定数量建议，精确同名未出现不等于不存在；缺失为null，真实零保留0。中文主标签命中只说明话题名称相同，常见名是否属于该干员仍待核实，不能声称交集了“明日方舟”标签。

单标签成功结果保存到被Git忽略的 `.local/douyin/probe-topic.json`；后续失败另存 `probe-last-error.json`，保留之前成功数据。

`collect` 默认按花名册434个档案条目建立中文话题计划，不扩展别名。用户已确认阿米娅的术师、近卫和医疗只是同一人物的职业形态；三个明确ID统一查询 `#阿米娅` 一次，关联同一份统计，不相加。因此默认为434个档案、432个独立话题；其他带括号的名字不自动裁剪。单线程、至少3.5秒间隔。可用 `--operators 阿米娅,黍` 定向选择，用 `--refresh` 新建批次；默认 `--resume` 接续未结束且计划一致的任务。独立运行锁防止重复启动，受限时停止并保留断点；`stop`只影响抖音，当前请求结束后退出。

`remap` 在任务结束或保存停止后离线整理已采集结果，建立修正映射的新批次；沿用已有话题的原生值、来源和原始采集时间，旧批次历史保留。阿米娅职业形态不另查标签，不把旧的形态标签零值加进来；整理不发起HTTP请求，其他失败项仍保留为失败。

SQLite 中的 `douyin_tag_stats`、`douyin_tag_history`、`douyin_tag_queue` 分别保存最新结果、分批历史和断点，结果与断点同事务提交；不修改其他平台业务表。`.local/douyin/http-job.json` 保存进度，每2秒更新，`.local/douyin/topic-counts.json` 导出当前批次已处理结果。缺失与无同名结果记为无法取得，统计为null；同名歧义或结构错误记为失败，不覆盖之前成功值。完成全部查询仍保留接口覆盖与角色归属未核实的说明，不称全站完整采集。

网站读取独立小快照 `/api/douyin/tag-counts`，静态回退 `/data/douyin-tag-counts.json`，每5秒更新；抖音页不请求逐作品巨型汇总。`export` 只整理已有统计，不请求抖音。导出器 `scripts/douyin_topic_export.py` 校验原生播放量、话题ID、来源、采集时间及档案归属；只导出白名单字段，原始响应和加密会话不进入网站。正式采集器发布进度时自动导出后续更新。

抖音页展示“话题播放量排行”，不套用点赞、作品数或年份图表；同名话题角色归属待核实，缺失不填零。阿米娅只显示一个排行条目，三个职业形态共用同一份统计；432个独立话题中当前430个有原生数值、2个失败。列表以万／亿简写，详情和CSV保留完整整数、话题ID、来源与原始采集时间。所有快照被Git忽略，仅供本地网站使用。

用户指定将播放量10亿及以上的同名话题结果默认隐藏；阈值在 `src/douyinAmbiguity.ts`，按当前快照的原生播放量判断，不按筛选或排序结果截取。仅抖音页在“联动”左侧显示独立“隐藏同名”开关，关闭恢复全部条目；不改动原始统计、联动状态或筛选条件。悬停、键盘聚焦及手机点按可见说明，Esc可关闭提示。页面排行和CSV遵循当前开关，不将隐藏名单理解为其余条目已完成角色归属核验。

公共模块保留：`tag_collect.py` 调度、`tag_session.py` HTTP 与加密会话、`tag_store.py` SQLite、`tag_match.py` 原生标签归属。`collector_sources/base.py` 存放公共作品和分页类型。`tag_sources.py` 仅保留旧导入路径、注册及辅助函数兼容；旧命令仍可用。

## Pixiv 从旧任务无缝接续

拆分不要求重启正在运行的旧进程。Python 已加载的采集实现继续运行，速度监视器仍然读取原数据库和原进度文件。需要切换时，先请求旧任务正常退出：

```powershell
python -X utf8 scripts/pixiv_collect.py stop
python -X utf8 scripts/pixiv_collect.py status
```

等任务状态变为 `cancelled`、`completed` 或 `failed`，并确认旧采集进程退出，再用新入口继续：

```powershell
python -X utf8 scripts/pixiv_collect.py collect --workers 16 --delay-range 2 4
```

新入口固定为 Pixiv，并自动带上 `--resume`；不指定干员就是全部 434 位。不要另传 `--platforms`。需要明确写出断点参数也可以：

```powershell
python -X utf8 scripts/pixiv_collect.py collect --workers 16 --delay-range 2 4 --resume
python -X utf8 scripts/pixiv_collect.py collect --stage metrics --workers 16 --delay-range 2 4
```

`--delay-range 2 4` 使每个线程在每次 HTTP 尝试前独立随机休眠 2～4 秒，包括首次请求、搜索、对照请求、详情和重试；它替代固定 `--interval`。这是每线程休眠，不是所有 16 个线程共用的全局 2～4 秒间隔。遇到限流时仍额外遵守共享退避，且随机休眠结束后会再次检查共享冷却。未启用随机范围时，原固定间隔逻辑保留；LOFTER 参数不变。

保留以下原路径，不搬库、不重新导入旧 JSON、不改变表结构或查询键：

- `.local/http-collection.sqlite`：作品、归属、分页断点、指标待处理队列。
- `.local/http-job.json`、`.local/http-control.json`：原进度与停止信号。
- `.local/http-run.lock`：原运行锁，防止旧、新入口同时采集。
- `.local/http-sessions/pixiv.dpapi`：原加密会话。

查询键仍为 `[platform, operatorId, tag, kind]` 的相同 JSON 字符串，Pixiv 游标 `mode/page/windows/got/total` 原样保留。小说 ID 仍带 `novel:` 前缀。已结束查询直接跳过；未完成查询读取原游标；指标队列继续逐件补采。中途未写完的页可能重放，按作品 ID 去重，不会重复累计。原有 `failed`、`partial` 状态仍按旧逻辑重扫该标签，不等于整库重抓。

B站独立入口现使用下述独立运行控制。其余五个平台的新入口仍共用公共任务控制和运行锁；需要这些平台之间并行时，使用 `tag_collect.py collect --platforms ... --resume`。LOFTER 的运行控制也单独保存。

拆分验证：六个已有平台类与拆分前 AST 相同；从在线库通过 SQLite backup 得到副本，在副本核对真实 Pixiv 查询状态和游标，并模拟从已有页继续前进。验证不修改正在运行的正式库。

## 哔哩哔哩：单角色 TAG 使用数，本体与异格合并

```powershell
python -X utf8 scripts/bilibili_collect.py collect --workers 1 --interval 1.5 --resume
python -X utf8 scripts/bilibili_collect.py collect --refresh
python -X utf8 scripts/bilibili_collect.py stats
python -X utf8 scripts/bilibili_collect.py export
python -X utf8 scripts/bilibili_collect.py status
python -X utf8 scripts/bilibili_collect.py stop
python -X utf8 scripts/bilibili_watch.py
```

用户于 2026-11-07 选择单角色 TAG 快查。当前入口调用 bilibili_single_tags.py 和
collector_sources/bilibili_counts.py：仅用花名册中文主名查询 /x/tag/info?tag_name=角色名，
不加「明日方舟」，联动也不加作品名；不查询别名、不翻视频列表、不逐件请求详情。
默认单线程，请求起点最小间隔 1.5 秒；六星优先。完整名单为 434 个角色/形态，正常每个 TAG 一请求，
括号名称遇到 16001 时额外尝试全角括号。16001 记为不可读取，其他错误如实记录；受限停止，不补零。

每条统计保留 count.use、原生 count（包括关注字段）、标签名称与 ID、API 来源及采集时间。
count.view 不作为播放/浏览量使用，汇总没有单件发布时间，publishedAt 为 null。
不提供年度数、累计视频播放或互动总量，也不把 count.use 称为已核验作品数。

FORM_BASE_IDS 明确维护 40 个异格/职业形态与本体的对应关系。导出时 434 个档案合为 394 个角色，
本体一行显示，components 保留每个形态 TAG 的小计、原生指标、来源、状态和采集时间。
合计是各 TAG 的使用次数：同一视频打多个形态 TAG 会重复计入，不是去重作品总数。
同一 TAG 只查询并累计一次；某个形态缺失时保留 null，有数据的部分小计标下限；全部缺失时合计 null。

SQLite 仍用 B站独立统计/历史/队列表；新 key 前缀为 single_tag_v1:，批次规则为
bilibili_single_character_tag_use_v1。旧单标签、组合搜索和严格交集历史保留，均不能混入新快照，
也不能作为新批次的完成断点。--resume 接续同计划未完成的新批次，--refresh 重新读取全部。

默认写入新版网站 D:/RhodesIndex，可用 collect --website-root <目录> 指定。
workCount 是兼容字段；单条 countBasis=native_tag_use，合并记录 countBasis=native_tag_use_sum。
本地 API 与静态回退每 5 秒读取最新合并快照，网页显示「标签使用数」，详情列明各形态。
搜索异格、按形态职业/星级筛选和异格关注可找到合并角色。
监视器仍显示本轮原始 TAG 的完成进度，不把 394 个角色误当 434 个请求。

旧 `bilibili_search_runtime.py`、`bilibili_count_runtime.py` 和逐作品适配器作为历史源码保留。
reset 是显式清理旧 B站数据的命令，本次切换无需执行，不清除其他平台或登录凭据。

## LOFTER 角色标签浏览与参与

LOFTER 已按新的需求改为标签汇总，不再逐件采集作品。按用户2026-11-03的调整，默认只读取全部434位干员的中文主标签，共434个，不再额外查询日文、英文或“明日方舟”前缀变体；不同标签分别保存，不相加为角色去重作品总数。旧2,500标签方案的最新值、历史快照和队列均在重新启动前清理。

每个标签只读取 `https://www.lofter.com/tag/<标签>/new` 页头的 `tag-count` 容器，不请求作品列表 API、作品详情，也不再创建 LOFTER 的作品记录。

```powershell
python -X utf8 scripts/lofter_collect.py probe --tag 拉普兰德
python -X utf8 scripts/lofter_collect.py collect --workers 3 --interval 3.5 --resume
python -X utf8 scripts/lofter_collect.py status
python -X utf8 scripts/lofter_collect.py stats
python -X utf8 scripts/lofter_collect.py export
python -X utf8 scripts/lofter_collect.py stop
python -X utf8 scripts/lofter_watch.py
```

未完成时，同一命令接续当前批次，已处理标签不重复读取。完成后再次执行会建立新的标签统计快照；需要立即开启新一轮更新时使用 `collect --refresh`。以后更新仍只读取标签页，不需要从历史作品重新翻页。中文主标签是默认且唯一的CLI范围，`--primary-only` 仅为兼容旧命令保留。默认仍为3线程、全局每3.5秒最多发出一次请求，监视器总计划为434个标签。

保存字段为标签原文、关联干员 ID、来源链接、采集时间，以及页面原始显示的浏览和参与：

- `861.8万浏览`：保留 `display: "861.8万"`、`exact: false`、`value: null`、`estimate: 8618000`；估计值不能冒充精确浏览量。
- `45771参与`：保留 `display: "45771"`、`exact: true`、`value: 45771`。它是页面显示的参与数，不声称已经核验为可访问的去重作品数量。
- `0浏览 0参与`：只有统计容器真实显示了零才保存精确 0。
- 页面跳转到 `/wall`：保存 `status: unavailable`、缺失原因，数字留空；不直接认定为零或标签不存在。
- 真正的登录或验证重定向会停止任务并保留进度；其他结构错误记录失败，供下次重试。

这些是采集时标签的累计显示值，无法拆分成作品发布年份，也不能套用原先“干员 × 平台 × 作品年份”的逐作品统计。不同标签之间有重叠，浏览和参与不能直接求和。

仍使用 `.local/http-collection.sqlite`，新增表与其他平台作品数据分开：

| 表                                               | 用途                                       |
| ------------------------------------------------ | ------------------------------------------ |
| `lofter_tag_stats(tag_key, data)`                | 每个原始标签最新的统计及精度、缺失标记     |
| `lofter_tag_history(run_id, tag_key, data)`      | 每轮标签统计的快照历史                     |
| `lofter_tag_queue(run_id, tag_key, state, note)` | 成功、缺失、失败、取消等处理状态和恢复依据 |

最新值、历史快照及成功状态在同一 SQLite 事务提交。读取失败不会覆盖之前成功的统计。不同原始拼写不在缺少平台证据时擅自合并。自动导出仅包含434条标签汇总的小型JSON，不生成逐作品的巨大JSON。

原LOFTER作品、作品关联、旧分页、水位记录、旧标签统计、统计历史和标签队列，以及本地导出中的LOFTER条目均按平台清理；旧SQLite备份和验证副本也同步清理。清理在单个SQLite写事务内校验B站标签统计、历史和队列的哈希，允许B站数量采集进程继续运行。报告保存在 `.local/lofter/cleanup-report.json`。Pixiv 等其他平台的数据、断点和进程保留。旧 `lofter_runtime.py`／`collector_sources/lofter.py` 只作历史实现留存，不再由 LOFTER 入口启动。

独立运行控制仍位于 `.local/lofter/http-job.json`、`http-control.json`、`http-run.lock`。监视器现显示标签处理速度、成功／缺失数量、角色覆盖、最近标签的原始浏览和参与，不再显示 LOFTER 作品采集速度。关闭监视器不会停止采集。

登录继续复用 `.local/http-sessions/lofter.dpapi` 中的 Windows DPAPI 加密 Cookie，需要更新时运行 `python -X utf8 scripts/lofter_collect.py session`，不要把 Cookie 放进命令参数、普通配置或聊天。

网站LOFTER页面已接入 `/api/lofter/tag-counts`，静态回退为 `/data/lofter-tag-counts.json`。默认按参与排序，可切换浏览；数值保留平台原文并区分精确／约数，缺失显示“未取得”。约数仅按估计显示值排序，不声称真实大小关系或去重作品数。来源详情同时展示原生浏览和参与，CSV包含原始显示、精度、来源及采集时间。`export` 仅整理已保存数据，不访问平台；后续采集状态变化自动刷新网站快照。所有快照仅在本机保存，不上传GitHub。

## 验证命令

```powershell
python -X utf8 -m unittest discover -s scripts -p 'test_*.py'
python -X utf8 -m compileall -q scripts
npm.cmd test
npm.cmd run build
npm.cmd run format:check
```
