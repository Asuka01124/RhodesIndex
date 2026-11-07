# 罗德指数 · RhodesIndex

比较《明日方舟》干员在不同创作平台上的相对热度。

**[打开网站](https://asuka01124.github.io/RhodesIndex/)**

支持 Pixiv、哔哩哔哩、微博、小红书、抖音、森空岛和 LOFTER，提供排行、条形图与热力图、干员筛选、关注对比及隐藏干员。界面偏好保存在当前浏览器。

## 数据说明

- Pixiv 展示中文本体标签的年度作品数；浏览、点赞、收藏和评论来自已完成的逐作品统计，覆盖范围不同。
- B站展示单角色 TAG 使用数，本体与异格合并；不同 TAG 未去重。
- 微博、小红书、抖音、森空岛与 LOFTER 使用各自的话题或标签汇总指标，具体规则见页面顶部说明按钮。

不同平台的数字不直接相加。缺失值留空，平台约数保留约数标记；同名话题仍可能影响排名。网站为汇总快照，不会在访问时自动抓取平台数据。

## 本地开发

需要 Node.js 24 或更新版本。

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run format:check
```

## 更新与部署

网站源码在 main 分支，[HTTP 采集脚本在 collectors 分支](https://github.com/Asuka01124/RhodesIndex/tree/collectors)。

采集结果保存在本机。运行 `npm run data:publish`，从本机快照导出并校验可公开的汇总；提交后由 GitHub Actions 构建并部署到 GitHub Pages。

公开内容仅包含网站代码、干员目录、头像与必要的汇总统计。原始作品明细、数据库、断点、登录凭据和日志不发布；构建使用文件白名单，不会复制整个本地数据目录。

干员资料与头像来源：[PRTS](https://prts.wiki/w/干员一览)。本项目为非官方统计展示，平台指标以对应来源与采集时点为准。
