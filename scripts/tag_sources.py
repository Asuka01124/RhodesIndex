"""旧导入路径兼容层；各平台实现已移至 collector_sources/。"""

import time  # 保留旧导入及既有测试的补丁路径。
from collector_sources.base import Source, Page, now, date_value
from collector_sources.pixiv import Pixiv
from collector_sources.bilibili import Bilibili
from collector_sources.xiaohongshu import Xiaohongshu
from collector_sources.youtube import Youtube
from collector_sources.bluesky import Bluesky
from collector_sources.tumblr import Tumblr
from collector_sources.youtube import embedded_json, walk
from collector_sources.lofter import Lofter  # 使用 lofter_collect.py 的独立增量调度器。

SOURCES = {cls.platform: cls for cls in [Pixiv, Xiaohongshu, Youtube, Bluesky, Tumblr]}
