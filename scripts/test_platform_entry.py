"""平台拆分后保持旧命令、类身份和断点格式兼容。"""

import unittest
from unittest.mock import patch

import platform_entry
from tag_session import CollectError
import tag_sources
from collector_sources.pixiv import Pixiv
from collector_sources.base import Page


class PlatformEntryTests(unittest.TestCase):
    def test_pixiv_defaults_to_resume_without_narrowing_operator_scope(self):
        with patch("platform_entry.main") as main:
            platform_entry.run("pixiv", ["collect", "--workers", "6", "--interval", "0.9"])
        self.assertEqual(
            main.call_args.args[0],
            ["collect", "--workers", "6", "--interval", "0.9", "--platforms", "pixiv", "--resume"],
        )

    def test_each_existing_platform_has_a_fixed_independent_entry(self):
        for platform in tag_sources.SOURCES:
            with self.subTest(platform=platform), patch("platform_entry.main") as main:
                platform_entry.run(platform, ["collect", "--resume"])
                self.assertEqual(main.call_args.args[0].count("--resume"), 1)
                self.assertEqual(main.call_args.args[0][-2:], ["--platforms", platform])

    def test_independent_entry_rejects_another_platform(self):
        with self.assertRaises(CollectError), patch("platform_entry.main") as main:
            platform_entry.run("pixiv", ["collect", "--platforms=bilibili"])
        main.assert_not_called()

    def test_session_is_always_saved_to_the_selected_platform(self):
        with patch("platform_entry.main") as main:
            platform_entry.run("pixiv", ["session"])
        self.assertEqual(main.call_args.args[0], ["session", "--platform", "pixiv"])

    def test_old_imports_are_the_same_classes(self):
        self.assertIs(tag_sources.Pixiv, Pixiv)
        self.assertIs(tag_sources.Page, Page)


if __name__ == "__main__":
    unittest.main()
