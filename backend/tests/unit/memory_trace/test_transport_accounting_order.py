"""提取物理回执必须先结算，再允许同批次来源核验预约。"""

from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_trace.context import TraceSession
from notalone.memory_trace.transport import invoke_traced_model
from notalone.scopes import ContactScope


class _TraceStore:
    def __init__(self):
        self.events = []
        self.receipts = []

    def append(self, *args, **kwargs):
        self.events.append(kwargs["stage"])

    def record_call(self, *args, **kwargs):
        self.receipts.append(kwargs["receipt"])

    def complete(self, *args, **kwargs):
        pass


class _PhysicalCall:
    def __init__(self):
        self.dispatched = True
        self.ledger_entry_id = uuid4()
        self.called_at = datetime.now(timezone.utc)
        self.entry = None

    @property
    def pending(self):
        return self.entry is None

    def complete(self, entry):
        self.entry = entry

    def unknown(self):
        pass


class _Model:
    def __init__(self):
        self.calls = []
        self.current = None

    def bind_tools(self, schema, **options):
        owner = self
        return SimpleNamespace(
            invoke=lambda messages: owner.invoke(schema[0]),
        )

    def invoke(self, schema):
        return {"schema": schema["title"], "physical_call": self.current}


class _ExtractionRuntime:
    def __init__(self, model):
        self.model = model

    def extract(self, window):
        invoke_traced_model(
            self.model,
            purpose="extraction",
            schema={"title": "Extraction"},
            messages=[],
        )
        return ()


class TransportAccountingOrderTest(unittest.TestCase):
    def test_a_receipt_is_settled_before_verification_call(self):
        scope = ContactScope(uuid4(), uuid4())
        store, model = _TraceStore(), _Model()
        window = SimpleNamespace(
            owner_id=scope.owner_id,
            contact_id=scope.contact_id,
            messages=(),
            target_message_ids=(),
            message_id_set=frozenset(),
            target_message_id_set=frozenset(),
        )

        @contextmanager
        def physical_trace_call(observation, _model):
            if model.calls and model.calls[-1].pending:
                raise RuntimeError("physical_reservation_unconfirmed")
            call = _PhysicalCall()
            model.current = call
            model.calls.append(call)
            observation.physical_call = call
            yield call

        with patch(
            "notalone.memory_trace.transport.physical_trace_call",
            physical_trace_call,
        ):
            with TraceSession(
                store,
                scope,
                uuid4(),
                provider="deepseek",
                model_name="synthetic",
            ) as trace:
                trace.ledger = SimpleNamespace(record=lambda entry: entry)
                ExtractionFlow(
                    runtime=_ExtractionRuntime(model),
                ).run(window)
                invoke_traced_model(
                    model,
                    purpose="verification",
                    schema={"title": "Verification"},
                    messages=[],
                )

        self.assertFalse(model.calls[0].pending)
        self.assertEqual(store.events.count("ledger_call"), 1)
