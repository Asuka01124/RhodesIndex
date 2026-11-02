# 分平台采集器

所有命令在 `D:\RhodesIndex` 下运行。只使用纯 HTTP，不依赖 Vite，不部署。凭据继续使用已有的 DPAPI 加密会话或明确的环境变量引用。

## 文件划分

| 平台     | 独立入口                         | 接口实现                                   |
| -------- | -------------------------------- | ------------------------------------------ |
| Pixiv    | `scripts/pixiv_collect.py`       | `scripts/collector_sources/pixiv.py`       |
| 哔哩哔哩 | `scripts/bilibili_collect.py`    | `scripts/collector_sources/bilibili.py`    |
| 小红书   | `scripts/xiaohongshu_collect.py` | `scripts/collector_sources/xiaohongshu.py` |
| YouTube  | `scripts/youtube_collect.py`     | `scripts/collector_sources/youtube.py`     |
| Bluesky  | `scripts/bluesky_collect.py`     | `scripts/collector_sources/bluesky.py`     |
| Tumblr   | `scripts/tumblr_collect.py`      | `scripts/collector_sources/tumblr.py`      |
| LOFTER   | `scripts/lofter_collect.py`      | `scripts/collector_sources/lofter_tags.py` |

微博、X、抖音原本没有已实现的适配器，仍为待实现，不用空脚本冒充已接通。小红书按此前决定继续暂停，不能因为拆分而重新启动。

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

上述六个旧平台的新入口共用公共任务控制和运行锁；它们不是六个可以同时重复启动的采集服务。需要旧平台之间并行时，仍使用 `tag_collect.py collect --platforms ... --resume`。LOFTER 的运行控制单独保存，允许与当前 Pixiv 同时运行。

拆分验证：六个已有平台类与拆分前 AST 相同；从在线库通过 SQLite backup 得到副本，在副本核对真实 Pixiv 查询状态和游标，并模拟从已有页继续前进。验证不修改正在运行的正式库。

## LOFTER 角色标签浏览与参与

LOFTER 已按新的需求改为标签汇总，不再逐件采集作品。默认保留全部 434 位干员的中、日、英文及前缀标签，约 2,500 个独立标签；不同标签分别保存，不相加为角色去重作品总数。

每个标签只读取 `https://www.lofter.com/tag/<标签>/new` 页头的 `tag-count` 容器，不请求作品列表 API、作品详情，也不再创建 LOFTER 的作品记录。

```powershell
python -X utf8 scripts/lofter_collect.py probe --tag 拉普兰德
python -X utf8 scripts/lofter_collect.py collect --workers 3 --interval 3.5 --resume
python -X utf8 scripts/lofter_collect.py status
python -X utf8 scripts/lofter_collect.py stats
python -X utf8 scripts/lofter_collect.py stop
python -X utf8 scripts/lofter_watch.py
```

未完成时，同一命令接续当前批次，已处理标签不重复读取。完成后再次执行会建立新的标签统计快照；需要立即开启新一轮更新时使用 `collect --refresh`。以后更新仍只读取标签页，不需要从历史作品重新翻页。`--primary-only` 可显式只读取中文主标签；本次任务未启用该选项，仍保留全部别名。

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

最新值、历史快照及成功状态在同一 SQLite 事务提交。读取失败不会覆盖之前成功的统计。不同原始拼写不在缺少平台证据时擅自合并。不会自动生成巨大 JSON 导出。

原 LOFTER 作品、作品关联、旧分页和水位记录，以及原 `.local/http-live.json` 与 `public/data/live-heat.json` 中的 LOFTER 条目已按平台过滤清理。Pixiv 等其他平台的数据、断点和进程保留。旧 `lofter_runtime.py`／`collector_sources/lofter.py` 只作历史实现留存，不再由 LOFTER 入口启动。

独立运行控制仍位于 `.local/lofter/http-job.json`、`http-control.json`、`http-run.lock`。监视器现显示标签处理速度、成功／缺失数量、角色覆盖、最近标签的原始浏览和参与，不再显示 LOFTER 作品采集速度。关闭监视器不会停止采集。

登录继续复用 `.local/http-sessions/lofter.dpapi` 中的 Windows DPAPI 加密 Cookie，需要更新时运行 `python -X utf8 scripts/lofter_collect.py session`，不要把 Cookie 放进命令参数、普通配置或聊天。

## 验证命令

```powershell
python -X utf8 -m unittest discover -s scripts -p 'test_*.py'
python -X utf8 -m compileall -q scripts
npm.cmd test
npm.cmd run build
npm.cmd run format:check
```
