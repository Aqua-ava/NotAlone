"""缺项协议只关闭模型能力，不替换或停止原共享control。"""
import unittest
from uuid import UUID
from notalone.server.model_control import build_model_priority_control, model_work_available


class ModelBootstrapTest(unittest.TestCase):
    def test_typescript_ready_cannot_use_local_control(self):
        local = build_model_priority_control(background_limit=3, environment={})
        with self.assertRaises(ValueError):
            model_work_available(control=local,
                owner_id=UUID('11111111-1111-4111-8111-111111111111'),
                environment={'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1'})
        local.stop()

    def test_missing_key_keeps_same_live_shared_control(self):
        environment = {'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1',
            'NOTALONE_MODEL_PERMIT_SOCKET': '/tmp/synthetic-unused.sock',
            'NOTALONE_MODEL_PERMIT_TOKEN': 'synthetic-' * 5,
            'NOTALONE_MODEL_UNCONFIGURED_REASON': 'reply_model_unconfigured'}
        control = build_model_priority_control(background_limit=3, environment=environment)
        self.assertFalse(model_work_available(control=control,
            owner_id=UUID('11111111-1111-4111-8111-111111111111'), environment=environment))
        self.assertFalse(control.stop_event.is_set())

    def test_default_python_keeps_original_model_capability(self):
        control = build_model_priority_control(background_limit=3, environment={})
        self.assertTrue(model_work_available(control=control, owner_id=None, environment={}))
        control.stop()

    def test_missing_owner_only_accepts_actual_unbound_child(self):
        environment = {'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1',
            'NOTALONE_MODEL_PERMIT_SOCKET': '/tmp/synthetic-unused.sock',
            'NOTALONE_MODEL_PERMIT_TOKEN': 'synthetic-' * 5,
            'NOTALONE_DEEPSEEK_API_KEY': 'synthetic-only',
            'NOTALONE_MODEL_UNCONFIGURED_REASON': 'reply_owner_unconfigured'}
        control = build_model_priority_control(background_limit=3, environment=environment)
        self.assertFalse(model_work_available(control=control, owner_id=None, environment=environment))
        with self.assertRaises(ValueError):
            model_work_available(control=control,
                owner_id=UUID('11111111-1111-4111-8111-111111111111'), environment=environment)

    def test_configured_cannot_use_missing_key_flag_to_disable_strict_08(self):
        environment = {'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1',
            'NOTALONE_MODEL_PERMIT_SOCKET': '/tmp/synthetic-unused.sock',
            'NOTALONE_MODEL_PERMIT_TOKEN': 'synthetic-' * 5,
            'NOTALONE_DEEPSEEK_API_KEY': 'synthetic-only',
            'NOTALONE_MODEL_UNCONFIGURED_REASON': 'reply_model_unconfigured'}
        control = build_model_priority_control(background_limit=3, environment=environment)
        owner = UUID('11111111-1111-4111-8111-111111111111')
        with self.assertRaises(ValueError):
            model_work_available(control=control, owner_id=owner, environment=environment)
        environment['NOTALONE_MODEL_UNCONFIGURED_REASON'] = ''
        self.assertTrue(model_work_available(control=control, owner_id=owner, environment=environment))

    def test_unknown_or_local_unconfigured_flag_fails_closed(self):
        local = build_model_priority_control(background_limit=3, environment={})
        for environment in ({'NOTALONE_MODEL_UNCONFIGURED_REASON': 'reply_model_unconfigured'},
                            {'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1',
                             'NOTALONE_MODEL_UNCONFIGURED_REASON': 'reply_model_unconfigured'}):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                model_work_available(control=local, owner_id=None, environment=environment)
        local.stop()
        shared_env = {'NOTALONE_REPLY_RUNTIME': 'typescript', 'NOTALONE_TS_HOST': '1',
            'NOTALONE_MODEL_PERMIT_SOCKET': '/tmp/synthetic-unused.sock',
            'NOTALONE_MODEL_PERMIT_TOKEN': 'synthetic-' * 5,
            'NOTALONE_MODEL_UNCONFIGURED_REASON': 'unknown-reason'}
        shared = build_model_priority_control(background_limit=3, environment=shared_env)
        with self.assertRaises(ValueError):
            model_work_available(control=shared, owner_id=None, environment=shared_env)
