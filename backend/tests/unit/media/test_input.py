"""非法输入在任何数据库或文件读取之前拒绝。"""

from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from notalone.media.service import MediaService
from notalone.scopes import ContactScope


class MediaInputTest(unittest.TestCase):
    def test_invalid_request_is_refused_without_database_or_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "cache"
            service = MediaService("not-a-connection-string", root)
            scope = ContactScope(uuid4(), uuid4())
            for key, variant in (("", None), ("x" * 129, None), ("valid", "../escape")):
                with self.subTest(key_length=len(key), variant=variant):
                    result = service.extract_media(scope, uuid4(), "original", key, variant=variant)
                    self.assertEqual(result.status, "invalid_request")
                    self.assertFalse(root.exists())
