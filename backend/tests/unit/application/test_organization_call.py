"""整理总预算在真实 guard 阻塞时耗尽，不能启动适配器或伪称提前释放。"""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
import unittest

from notalone.application.model_priority import ModelPriorityControl
from notalone.application.organization_call import bounded_organization_call
from notalone.memory.organization_deadline import OrganizationCallTimeout


class OrganizationCallDeadlineTest(unittest.TestCase):
    def test_guard_exhausts_total_budget_before_adapter_and_then_releases_foreground(self):
        priority = ModelPriorityControl()
        entered, release, finished, foreground = Event(), Event(), Event(), Event()
        calls = []

        def guard():
            entered.set()
            try:
                if not release.wait(2):
                    raise AssertionError("测试必须显式释放受控前置步骤")
            finally:
                finished.set()

        def adapter(deadline):
            calls.append(deadline)
            return "不应执行"

        def reply():
            with priority.foreground():
                foreground.set()

        with ThreadPoolExecutor(max_workers=2) as workers:
            try:
                result = workers.submit(bounded_organization_call, adapter,
                    priority=priority, guard=guard, timeout_seconds=.5)
                self.assertTrue(entered.wait(1))
                waiting_reply = workers.submit(reply)
                with self.assertRaises(OrganizationCallTimeout):
                    result.result(2)
                self.assertEqual(calls, [])
                self.assertFalse(foreground.is_set(), "调用方到期不能冒充实际前置步骤已结束")
                release.set()
                waiting_reply.result(1)
                self.assertTrue(finished.is_set())
                self.assertTrue(foreground.is_set())
                self.assertEqual(calls, [], "迟到的 guard 返回后仍不得进入适配器")
            finally:
                release.set()
