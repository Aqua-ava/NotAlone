"""默认运行时无需operator评测配置，装配有限四阶段适配器且构造不联网。"""

import os
import unittest
from unittest.mock import patch

from notalone.application.organization_runtime import build_layered_memory_service


class DefaultOrganizationRuntimeTest(unittest.TestCase):
    def test_model_configuration_builds_verified_item_maintenance_without_suite(self):
        with patch.dict(os.environ, {
            'NOTALONE_ORGANIZATION_QUALITY_CONFIG': '',
            'NOTALONE_DEEPSEEK_API_KEY': 'synthetic-offline-never-valid',
            'NOTALONE_DEEPSEEK_MODEL': 'deepseek-flash',
            'NOTALONE_DEEPSEEK_BASE_URL': 'https://api.deepseek.com',
        }), patch('httpx.HTTPTransport.handle_request', side_effect=AssertionError('构造不得联网')):
            service = build_layered_memory_service('postgresql:///synthetic_unused_test')
            try:
                self.assertEqual(service.runtime_policy, 'verified_items')
                self.assertIsNotNone(service.default_reply_budgets())
            finally:
                service.stop()

    def test_configured_compatible_model_does_not_require_flash_qualification(self):
        from notalone.reply.adapters.ecnu_input_budget import ECNU_BASE_URL, ECNU_MODEL
        with patch.dict(os.environ, {
            'NOTALONE_ORGANIZATION_QUALITY_CONFIG': '',
            'NOTALONE_DEEPSEEK_API_KEY': 'synthetic-offline-never-valid',
            'NOTALONE_DEEPSEEK_MODEL': ECNU_MODEL,
            'NOTALONE_DEEPSEEK_BASE_URL': ECNU_BASE_URL,
        }), patch('httpx.HTTPTransport.handle_request', side_effect=AssertionError('构造不得联网')):
            service = build_layered_memory_service('postgresql:///synthetic_unused_test')
            try:
                self.assertIsNotNone(service.default_reply_budgets())
                self.assertEqual(service.runtime_policy, 'verified_items')
            finally:
                service.stop()
