"""已退役的旧资料升级接口不能读取资料、创建任务或调用模型。"""

import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.server.app import create_app
from notalone.server.testing import InProcessClient


class MemoryUpgradeRemovedTest(unittest.TestCase):
    def test_old_endpoints_are_not_found_without_database_access(self):
        client = InProcessClient(create_app(
            database_url='postgresql:///synthetic_unused_test', owner_id=uuid4(),
            token='synthetic-removed-upgrade',
        ))
        with patch('psycopg.connect', side_effect=AssertionError('退役功能不得访问数据库')):
            for method in ('GET', 'POST'):
                for path in ('/api/memory-upgrades', f'/api/memory-upgrades/{uuid4()}'):
                    with self.subTest(method=method, path=path):
                        result = client.request(method, path,
                            headers={'Authorization': 'Bearer synthetic-removed-upgrade'},
                            body=b'{}')
                        self.assertEqual(result.status_code, 404)
