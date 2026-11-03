"""使用运行时生成的临时值验证会话输入，不包含真实凭据。"""

import json
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

import douyin_session as session
from tag_session import CollectError


class DouyinSessionTests(unittest.TestCase):
    def test_header_prefix_and_native_json_values(self):
        value = secrets.token_hex(12)
        native = json.dumps({"sample": value}, separators=(",", ":"))
        self.assertEqual(
            session.parse_session_cookie(f"Cookie: example={native}; another={value}==;"),
            {"example": native, "another": value + "=="},
        )

    def test_empty_input_reports_empty(self):
        with self.assertRaisesRegex(CollectError, "输入为空"):
            session.parse_session_cookie("")

    def test_rejects_other_headers_and_table(self):
        for raw in ["Cookie:", "name\tvalue", "Cookie: name=value\nOrigin: https://www.douyin.com", "Set-Cookie: name=value"]:
            with self.subTest(raw=raw), self.assertRaises(CollectError):
                session.parse_session_cookie(raw)

    def test_rejects_duplicate_names_without_disclosing_values(self):
        value = secrets.token_hex(12)
        with self.assertRaises(CollectError) as caught:
            session.parse_session_cookie(f"example={value}; example={value}")
        self.assertNotIn(value, str(caught.exception))

    def test_encryption_failure_preserves_previous_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "http-sessions" / "douyin.dpapi"
            target.parent.mkdir()
            previous = secrets.token_bytes(32)
            target.write_bytes(previous)
            with patch.object(session, "LOCAL", root), patch.object(session, "protect", side_effect=CollectError("加密失败")):
                with self.assertRaises(CollectError):
                    session.save_session({"example": secrets.token_hex(12)})
            self.assertEqual(target.read_bytes(), previous)

    def test_saves_only_encrypted_bytes_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            encrypted = secrets.token_bytes(32)
            with patch.object(session, "LOCAL", root), patch.object(session, "protect", return_value=encrypted):
                session.save_session({"example": secrets.token_hex(12)})
            self.assertEqual((root / "http-sessions" / "douyin.dpapi").read_bytes(), encrypted)
            self.assertEqual(len(list((root / "http-sessions").iterdir())), 1)

    def test_retries_format_error_without_saving_invalid_input(self):
        value = secrets.token_hex(12)
        with patch.object(session.sys.stdin, "isatty", return_value=True), patch.object(session.getpass, "getpass", side_effect=["", f"Cookie: example={value}"]), patch.object(session, "save_session") as save, patch("builtins.print") as output:
            self.assertEqual(session.main([]), 0)
        save.assert_called_once_with({"example": value})
        self.assertNotIn(value, repr(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
