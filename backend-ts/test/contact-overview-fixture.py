"""概览迁移差分的合成事件夹具；仅复用原测试模型，不访问真实模型或资料。"""
import json
import os
import sys
import unittest

from tests.integration.server.memory_overview_support import MemoryOverviewHttpFixture
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture

url = sys.argv[1]
name = url.split('dbname=')[1]
assert name.startswith('notalone_ts_host_') and name.endswith('_test')
for key in ('NOTALONE_TEST_DATABASE_URL', 'NOTALONE_DATABASE_URL'):
    os.environ[key] = url
os.environ['NOTALONE_EXPECTED_TEST_DATABASE'] = name


class Fixture(MemoryOverviewHttpFixture, unittest.TestCase):
    _wait_finished = CoreBusinessFlowFixture._wait_finished


Fixture.setUpClass()
fixture = Fixture()
try:
    fixture.setUp()
    fixture.activate_historical_review_worker()
    imported = fixture.import_event(
        original='合成计划：明天参加读书会。', claim='对方计划参加读书会。',
        when='2026-08-04T10:00:00+08:00', event_spec={'stage': 'planned'},
        event_verification={'stage_verdict': 'supported', 'occurrence_verdict': 'uncertain'},
    )
    contact = imported['contact_id']
    candidates = fixture._get(fixture.backend, f'/api/contacts/{contact}/memory-candidates')['candidates']
    status, confirmed = fixture.backend.request(f"/api/contacts/{contact}/memory-candidates/{candidates[0]['candidate_id']}/confirm", {})
    fixture.assertEqual(status, 200, confirmed)
    print(json.dumps({'owner': str(fixture.owner_id), 'contact': contact, 'overview': fixture.overview(contact)}))
finally:
    # 数据属于外层明确创建的合成库，由 Node fixture 统一删除。
    fixture._cleanups = [item for item in fixture._cleanups if getattr(item[0], '__name__', '') != '_remove_owner']
    fixture.doCleanups()
