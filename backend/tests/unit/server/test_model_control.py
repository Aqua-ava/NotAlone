"""共享control只在启动选择；不连接数据库或外部模型。"""
import unittest
from notalone.server.model_control import build_model_priority_control
from notalone.application.model_priority import ModelPriorityControl
from notalone.application.model_permit_client import SharedModelPriorityControl


class ModelControlTest(unittest.TestCase):
    def test_default_without_model_uses_original_local_control(self):
        control=build_model_priority_control(background_limit=3,environment={})
        self.assertIs(type(control),ModelPriorityControl)
        control.stop()

    def test_explicit_typescript_uses_unique_shared_control(self):
        control=build_model_priority_control(background_limit=3,environment={
            "NOTALONE_TS_HOST":"1","NOTALONE_REPLY_RUNTIME":"typescript",
            "NOTALONE_MODEL_PERMIT_SOCKET":"/tmp/synthetic-unused.sock",
            "NOTALONE_MODEL_PERMIT_TOKEN":"synthetic-"*5})
        self.assertIs(type(control),SharedModelPriorityControl)
        self.assertEqual(control._socket_path,"/tmp/synthetic-unused.sock")
        control.stop()

    def test_incomplete_shared_configuration_and_conflict_fail_closed(self):
        complete={"NOTALONE_TS_HOST":"1","NOTALONE_REPLY_RUNTIME":"typescript",
                  "NOTALONE_MODEL_PERMIT_SOCKET":"/tmp/synthetic-unused.sock",
                  "NOTALONE_MODEL_PERMIT_TOKEN":"synthetic-"*5}
        variants=[]
        for key in ("NOTALONE_TS_HOST","NOTALONE_MODEL_PERMIT_SOCKET","NOTALONE_MODEL_PERMIT_TOKEN"):
            env=dict(complete);env.pop(key);variants.append(env)
        variants.extend([{**complete,"NOTALONE_REPLY_RUNTIME":"python"},
                         {**complete,"NOTALONE_REPLY_RUNTIME":"typo"},
                         {**complete,"NOTALONE_MODEL_PERMIT_SOCKET":"relative.sock"},
                         {**complete,"NOTALONE_MODEL_PERMIT_TOKEN":"bad\n"*10}])
        for env in variants:
            with self.subTest(keys=sorted(env)),self.assertRaises(ValueError):
                build_model_priority_control(background_limit=3,environment=env)
