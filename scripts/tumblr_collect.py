"""tumblr 独立采集入口；默认接续旧 SQLite 断点。"""

from platform_entry import entry


if __name__ == "__main__":
    entry("tumblr")
