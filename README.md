# 罗德指数

React + TypeScript + Vite 的《明日方舟》干员创作热度网站。434 份档案和头像来自 [PRTS](https://prts.wiki/w/干员一览)。参考 Kuro 的侧栏、灰白背景、留白和细线布局。

**仅在本机运行，不部署。源码与采集脚本可备份至用户指定的 GitHub 私有仓库；原始采集数据、统计快照、数据库、断点、登录凭据与日志仅保存在本机。**

私有仓库包含网站源码、采集脚本、测试、依赖清单与运行文档，以及网站运行所需的静态干员目录 `public/data/operators.json` 和头像。静态干员目录用于角色识别和标签配置，不包含采集到的作品或平台互动指标。首次上传采用当前源码的独立快照，不携带旧 Git 历史或 `.openai` 托管配置，也不启用自动部署。

## 运行网站

```powershell
npm install
npm run dev
```

打开终端输出的本机地址。网站具备 10 个平台入口，年度分色条形图／热力图、点赞／观看量切换、职业／阵营／性别筛选、干员详情与来源、关注和 JSON／CSV 导出。

## 纯 HTTP Session 采集

各平台接口已拆至 `scripts/collector_sources/`，独立入口、旧 Pixiv 断点衔接和 LOFTER 标签汇总命令见 [采集器说明](scripts/COLLECTORS.md)。`tag_sources.py` 保留兼容导入，`tag_collect.py` 保留公共调度及旧命令。

采集脚本独立于 Vite，使用 Python requests.Session，**不启动 Chrome、不导入 Playwright、不渲染页面、不设每位作品数量上限**。按配置的角色 TAG 翻页到接口结束，逐件取详情和原生标签，按作品 ID 去重并汇总到网站 JSON。B 站搜索达到返回上限时，递归细分发布时间区间后继续翻页。

```powershell
python -m pip install --target .local/python-libs -r scripts/requirements-collector.txt
python scripts/tag_collect.py collect
python scripts/tag_collect.py collect --platforms pixiv,bilibili,xiaohongshu --operators 蕾缪安
python scripts/tag_collect.py collect --resume
python scripts/tag_collect.py status
python scripts/tag_collect.py stop
python scripts/tag_collect.py export
```

不指定干员即遍历全部 434 位。默认请求间隔 0.7 秒，平台之间并行、每个平台逐件处理。`--interval` 可调整间隔。分页游标和已取得的作品逐件写入 SQLite；停止或网络失败后用 `--resume` 继续。详情指标一小时内复用已保存观察结果，不反复累计同一作品。

也可使用 `npm.cmd run collect -- --resume`、`npm run collect:status`、`npm run collect:stop`。Windows PowerShell 用 `npm.cmd` 传递采集参数，避免 npm.ps1 丢失 `--`。

网站“管理采集”提交的任务同样是这个纯 Python 脚本，无浏览器遍历路径。

### 平台路径

- Pixiv：精确 TAG 的插画／漫画／动图列表，以及小说列表；逐件读取 `likeCount`、`viewCount`、原始发布时间与标签，收藏另存。
- 哔哩哔哩：分页检索候选视频，再读取原生 TAG 精确核对；使用 `stat.like`、`stat.view`。检索不是精确 TAG 列表，无法核验标签的候选不计入干员。
- 小红书：已登录 HTTP 会话配合 [xhshow](https://github.com/Cloxl/xhshow) 的纯 Python 请求签名；搜索所有笔记类型，分页读取，逐件核验原生标签与精确点赞。未提供公开观看量时保留 null。
- YouTube：HTTP 读取标签页的原始 JSON，再请求 continuation 分页；HTTP 作品详情中的原生标签、播放量与发布时间。无法核验精确点赞时为 null。
- Bluesky：HTTP XRPC 标签分页、原生 facet 标签和 likeCount；访问受限时如实记录，不启动浏览器回退。
- Tumblr：HTTP 读取公开标签流与下一页，使用原生 likeCount，不把 noteCount（喜欢、转发等总互动）当作点赞。
- LOFTER：独立运行 `scripts/lofter_collect.py`，仅读取各角色标签页头部的浏览和参与，保留全部中日英及前缀别名。缩写保留原始显示并标注近似；不同标签不相加。不再采集作品明细，旧 LOFTER 作品数据与断点已清理；支持中断续读及后续标签快照刷新。
- 微博、X、抖音仍待实现或验证对应的 HTTP 适配器；页面入口存在不代表数据已接通。

`tag_aliases()` 维护角色的中／日／英文标签及明日方舟命名空间变体。它定义每个平台实际遍历的 TAG 范围，不保证涵盖作者使用的所有昵称、拼写或未知标签。共享外文名的阿米娅不同职业形态不会混算。

### Cookie 与会话

用户已授权复用先前在本项目独立配置中登录的会话。脚本只读 `.local/browser-profiles/<平台>/`，使用当前 Windows 用户的 DPAPI 解密既有 Cookie 到内存；**不启动浏览器、不扫描用户其他浏览器配置、不导出明文 Cookie**。

也支持明确的 `RHODES_COOKIE_PIXIV`、`RHODES_COOKIE_BILIBILI`、`RHODES_COOKIE_XIAOHONGSHU` 等进程环境变量。需要补充会话时，在本机终端隐藏输入：

```powershell
python scripts/tag_collect.py session --platform xiaohongshu
```

会话使用 Windows DPAPI 加密保存到 `.local/http-sessions/`，不进入源码、普通配置、日志或前端。遇到验证码、401／403／429 等限制时，停止该平台并保存断点，不切换浏览器或伪造成功。网络使用明确代理环境变量或 Windows 当前系统代理。

## 数据文件与统计口径

- `.local/http-collection.sqlite`：逐件作品、分页游标、失败记录及每个标签的完成状态。
- `.local/http-job.json`：计划、当前进度、错误及运行状态。
- `.local/http-live.json`：网站实时读取的汇总 JSON，包含原始作品及来源。
- `public/data/live-heat.json`：同内容的可导出静态 JSON；若文件暂被占用，网站接口仍使用最新的 `.local/http-live.json`。
- `.local/observations.json`：旧版本观察数据，仅在首次建立 SQLite 时导入。

所有文件仅在本机保存。网站约每 4 秒刷新，脚本约每 15 秒导出汇总；每件作品先落库，导出间隔不会丢失作品断点。

每个平台作品对同一干员只计一次；一件作品关联多位干员时分别计入对应干员。年份按作品发布时间（北京时间）分组，数值是观察时累计互动，**不是当年新增互动**。收藏、转发和平台综合热度不能替代点赞。精确计数缺失或只有“1.2万”等缩写时为 null，不能冒充 0。

“已取完”表示配置的标签接口已经返回结束。重复分页、提前截断、声明数量与实际数量不符、详情失败或访问受限，均不标记为已取完。平台未返回、私密、删除作品或未知昵称标签无法据此保证覆盖；总体完成前界面继续明确显示部分覆盖。

## 验证

```powershell
npm test
npm run test:http
npm run build
npm run format:check
```

HTTP 脚本测试覆盖超过 240 件的持续分页、重复页面识别、接口数量截断、断点重放、去重、北京时间年份、精确标签与缺失指标。

## 主要代码

- `scripts/tag_collect.py`：无数量上限的独立 HTTP 采集队列与 CLI。
- `scripts/tag_session.py`：Session、网络、只读本机会话及 DPAPI 加密。
- `scripts/collector_sources/`：分平台的标签分页和原生指标适配器。
- `scripts/*_collect.py`：各平台独立入口，Pixiv 等旧平台默认接续同一 SQLite 断点；LOFTER 另有增量运行控制。
- `scripts/tag_sources.py`：旧平台导入与注册兼容层，不再集中存放接口实现。
- `scripts/tag_store.py`：逐件 SQLite、断点和网站 JSON 汇总。
- `server/http-plugin.ts`：仅本机的网站快照接口与脚本启动／停止入口。
- `src/CollectionPanel.tsx`、`src/useLiveData.ts`：采集管理与快照读取。
- `src/domain.ts`：筛选、年度汇总、导入与 CSV。

保留的 `.openai/hosting.json` 仅用于识别此前托管项目，不构成任何新的上传或部署授权。
