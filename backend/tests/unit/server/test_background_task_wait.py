"""验证验收等待能区分迟到完成、任务失败、未走分支和总预算截止。"""

from contextlib import redirect_stderr
from io import StringIO
import threading
import unittest
from unittest.mock import patch

from tests.integration.server import background_task_wait as waiting


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Backend:
    def __init__(self, clock, status):
        self.clock, self.status = clock, status
        self.requests = []

    def request(self, path, *, timeout):
        self.requests.append((path, timeout, self.clock.now))
        if "task_id=" not in path:
            return 200, {"status": "running", "progress": {"status": "busy"}}
        return 200, {"task_id": "synthetic-task", "status": self.status(),
                     "step": "extract_memory", "retry_count": 0, "error_code": None,
                     "steps": [{"name": "extract_memory", "status": "running",
                                "attempt_count": 1, "processed_count": int(self.clock.now * 100)}]}


class BackgroundTaskWaitTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.imported = {"task_id": "synthetic-task", "contact_id": "synthetic-contact"}
        for name, replacement in (("monotonic", self.clock.monotonic), ("sleep", self.clock.sleep)):
            current = patch.object(waiting.time, name, replacement)
            current.start()
            self.addCleanup(current.stop)
        self.logs = StringIO()
        self.enterContext(redirect_stderr(self.logs))

    def test_task_can_complete_after_old_ten_second_cutoff(self):
        backend = Backend(self.clock, lambda: "succeeded" if self.clock.now >= 12 else "running")
        task = waiting.wait_for_task(backend, self.imported, "succeeded")
        self.assertEqual(task["status"], "succeeded")
        self.assertGreaterEqual(self.clock.now, 12)
        self.assertIn("超过旧测试等待点", self.logs.getvalue())
        self.assertIn("达到预期", self.logs.getvalue())

    def test_unexpected_terminal_states_fail_without_waiting_out_budget(self):
        for status in ("failed", "cancelled"):
            with self.subTest(status=status):
                backend = Backend(self.clock, lambda: status)
                with self.assertRaises(waiting.TaskWaitError) as result:
                    waiting.wait_for_task(backend, self.imported, "succeeded")
                self.assertEqual(result.exception.reason, "unexpected_terminal_state")
                self.assertEqual(result.exception.task["status"], status)
                self.assertEqual(result.exception.host["status"], "running")
                self.assertEqual(self.clock.now, 0)

    def test_expected_failure_is_a_successful_observation(self):
        backend = Backend(self.clock, lambda: "failed")
        self.assertEqual(waiting.wait_for_task(backend, self.imported, "failed")["status"], "failed")
        self.assertEqual(len(backend.requests), 1)

    def test_running_progress_cannot_extend_total_budget(self):
        backend = Backend(self.clock, lambda: "running")
        with self.assertRaises(waiting.TaskWaitTimeout) as result:
            waiting.wait_for_task(backend, self.imported, "succeeded", timeout=1)
        failure = result.exception
        self.assertEqual(failure.reason, "test_deadline_exceeded")
        self.assertEqual(failure.task["status"], "running")
        self.assertLessEqual(len(failure.history), 8)
        self.assertAlmostEqual(self.clock.now, 1)
        for path, timeout, started in backend.requests:
            if "task_id=" in path:
                self.assertLessEqual(timeout, 1 - started)

    def test_completed_task_without_write_checkpoint_fails_immediately(self):
        backend = Backend(self.clock, lambda: "succeeded")
        with self.assertRaises(waiting.TaskWaitError) as result:
            waiting.wait_for_task_checkpoint(backend, self.imported, threading.Event())
        self.assertEqual(result.exception.reason, "checkpoint_not_reached")
        self.assertEqual(self.clock.now, 0)

    def test_write_checkpoint_can_arrive_after_old_eight_second_cutoff(self):
        checkpoint = threading.Event()

        def status():
            if self.clock.now >= 9:
                checkpoint.set()
            return "running"

        waiting.wait_for_task_checkpoint(Backend(self.clock, status), self.imported, checkpoint)
        self.assertTrue(checkpoint.is_set())
        self.assertGreaterEqual(self.clock.now, 9)
        self.assertIn("超过旧测试等待点", self.logs.getvalue())

    def test_waiting_for_checkpoint_is_still_bounded(self):
        backend = Backend(self.clock, lambda: "running")
        with self.assertRaises(waiting.TaskWaitTimeout) as result:
            waiting.wait_for_task_checkpoint(backend, self.imported, threading.Event(), timeout=0.2)
        self.assertEqual(result.exception.reason, "test_deadline_exceeded")
        self.assertAlmostEqual(self.clock.now, 0.2)

    def test_success_returned_after_request_exhausts_budget_is_not_accepted(self):
        backend = Backend(self.clock, lambda: "succeeded")
        original = backend.request

        def request(path, *, timeout):
            if "task_id=" in path:
                self.clock.now += 2
            return original(path, timeout=timeout)

        backend.request = request
        with self.assertRaises(waiting.TaskWaitTimeout):
            waiting.wait_for_task(backend, self.imported, "succeeded", timeout=1)

    def test_checkpoint_set_after_total_cutoff_is_not_accepted(self):
        checkpoint = threading.Event()

        def late_sleep(seconds):
            self.clock.now += seconds + 1
            checkpoint.set()

        with patch.object(waiting.time, "sleep", late_sleep):
            with self.assertRaises(waiting.TaskWaitTimeout):
                waiting.wait_for_task_checkpoint(Backend(self.clock, lambda: "running"),
                                                  self.imported, checkpoint, timeout=0.2)

    def test_unavailable_host_diagnostic_does_not_hide_original_task_failure(self):
        backend = Backend(self.clock, lambda: "failed")
        original = backend.request

        def request(path, *, timeout):
            if "task_id=" not in path:
                raise TimeoutError("合成状态诊断不可用")
            return original(path, timeout=timeout)

        backend.request = request
        with self.assertRaises(waiting.TaskWaitError) as result:
            waiting.wait_for_task(backend, self.imported, "succeeded")
        self.assertEqual(result.exception.reason, "unexpected_terminal_state")
        self.assertEqual(result.exception.host, {"diagnostic_error": "TimeoutError"})

    def test_non_finite_or_empty_budget_is_rejected(self):
        for timeout in (0, -1, float("inf"), float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                waiting.wait_for_task(Backend(self.clock, lambda: "running"),
                                      self.imported, "succeeded", timeout=timeout)
