"""设置重载门的合成HTTP／PG底座；不预填联系人、不调用外部模型。"""
import json
import os
import sys
import unittest
from dataclasses import replace
from unittest.mock import patch

from notalone.application.setup_service import SetupService
from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
from notalone.server.app import create_app
from notalone.server.reply_wiring import build_reply_service
from tests.fidelity_http_support import FidelityHttpFixture
from tests.input_budget_support import synthetic_budget_kwargs
from tests.integration.server.core_business_flow_support import HttpBackend


class Fixture(FidelityHttpFixture, unittest.TestCase):
    def _backend(self, owner_id):
        configuration = synthetic_budget_kwargs(self.reply_model)
        configuration['input_budget_profile'] = replace(configuration['input_budget_profile'],
            context_window_tokens=None, output_reserve_tokens=None, measurement_kind=None, measurement_id=None)
        configuration['input_token_counter'] = None
        with patch('notalone.server.reply_wiring.build_deepseek_model', return_value=self.reply_model):
            reply = build_reply_service(database_url=self.database_url, owner_id=owner_id, **configuration)
        backend = HttpBackend(create_app(database_url=self.database_url, owner_id=owner_id,
            token=f'synthetic-manual-change-{owner_id}', reply_service=reply,
            setup_service=SetupService(owner_directory=PostgresOwnerDirectory(self.database_url)),
            runtime_shutdown=lambda: None), owner_id)
        self.addCleanup(backend.close)
        return backend


fixture = Fixture()
try:
    Fixture.setUpClass()
    fixture.setUp()
    print(json.dumps({'ready': {'port': int(fixture.backend.base_url.rsplit(':', 1)[1]),
        'token': fixture.backend.token, 'pid': os.getpid()}}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command.get('operation') != 'stop':
            raise RuntimeError('unknown_synthetic_operation')
        break
finally:
    fixture.doCleanups()
    Fixture.doClassCleanups()
    print(json.dumps({'cleanup': True}), flush=True)
