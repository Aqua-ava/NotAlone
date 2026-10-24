"""原B消费远端A的账务归属与宿主关闭边界。"""
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from uuid import uuid4

from notalone.application.import_service import TaskHost
from notalone.memory_extraction.adoption import AdoptionStats
from notalone.memory_extraction.command import _BatchExtraction, _RunProgress, _commit_batch
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_trace.context import TraceSession
from notalone.scopes import ContactScope
from tests.support.ledger_adapters import InMemoryOutboundLedger


class ExtractionAConsumptionTest(unittest.TestCase):
    def test_b_preserves_ts_accounting_and_execution_even_when_adoption_fails(self):
        for remote, failure in ((True, False), (True, True), (False, False)):
            with self.subTest(remote=remote, failure=failure):
                scope = ContactScope(uuid4(), uuid4())
                execution, message = uuid4(), uuid4()
                metadata = dict(model_accounting_owner="typescript", a_execution_id=execution,
                    a_input_sha256="a" * 64, a_rule_version="b" * 64) if remote else {}
                outcome = ExtractionOutcome(accepted=(), extraction_completed=True, **metadata)
                extraction = _BatchExtraction(outcome, True, 0, 1, datetime.now(timezone.utc))
                completed = []
                store = SimpleNamespace(complete=lambda *args, **kwargs: completed.append(kwargs))
                trace = TraceSession(store, scope, uuid4())
                def adopt(*_):
                    if failure:
                        raise ExtractionRuntimeError("合成采纳阶段不可用")
                    return AdoptionStats()
                ledger = InMemoryOutboundLedger()
                stopped = _commit_batch(SimpleNamespace(batch=(SimpleNamespace(message_id=message),),
                    next_watermark=message, previous_watermark=None), extraction,
                    trace=trace, progress=_RunProgress(None), adoption=SimpleNamespace(adopt=adopt),
                    scope=scope, ledger=ledger, watermark_port=None, provider="deepseek", model_name="synthetic")
                self.assertEqual(stopped, failure)
                self.assertEqual(len(ledger.list_by_owner(scope.owner_id)), 0 if remote else 1)
                payload = completed[0]["payload"]
                if remote:
                    self.assertEqual(payload["typescript_a_receipt"], {
                        "a_execution_id": str(execution), "a_input_sha256": "a" * 64, "a_rule_version": "b" * 64})
                else:
                    self.assertNotIn("typescript_a_receipt", payload)

    def test_host_closes_owned_remote_before_join_and_only_once(self):
        events = []
        host = TaskHost(worker_builder=lambda: None, lock_connection_builder=lambda: None,
            event_publisher=lambda _: None,
            model_priority=SimpleNamespace(stop=lambda: events.append("priority_stop")),
            stop_callback=lambda: events.append("remote_close"))
        host.stop(timeout=0)
        host.stop(timeout=0)
        self.assertEqual(events.count("remote_close"), 1)
        self.assertEqual(events[:2], ["remote_close", "priority_stop"])
