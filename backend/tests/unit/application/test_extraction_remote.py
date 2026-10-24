"""合成私有A段边界；返回依据必须重新绑定本次实际窗口。"""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from contextlib import contextmanager
from contextvars import copy_context
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import threading
import unittest
from uuid import uuid4, uuid5, NAMESPACE_URL

from notalone.application.extraction_remote import (
    ExtractionRemoteInvalidResponse, decode_extraction_outcome,
)
from notalone.application.model_transport_accounting import physical_model_task
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.memory.evidence_binding import content_digest
from notalone.memory.events import MemoryEvent, EventStage, EventEvidence
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.flow import _to_fact, ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_trace.context import snapshot, TraceSession
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_flow import _payload


def fixture(*, event=False):
    message_id = uuid4()
    text = "合成联系人喜欢绿茶。"
    window = ExtractionWindow(uuid4(), uuid4(), (MessageRef(
        message_id, text, MessageSender.CONTACT,
        datetime(2026, 10, 1, 12, 0, 0, 123456, tzinfo=timezone.utc),
        source_snapshots=({"source_ref_id": str(uuid4()), "source_id": str(uuid4()),
            "source_kind": "source_document", "locator": "messages/0",
            "raw_payload": {"text": text}, "source_content_sha256": content_digest(text)},),
        message_type="text", text_representation="text",
    ),), (message_id,))
    fact = _to_fact(_payload(message_id, text=text))
    if event:
        fact = replace(fact, event=MemoryEvent(EventStage.PLANNED,
            stage_evidence=(EventEvidence(message_id, 0, 2),)))
    evidence = build_dimension_evidence(window, fact, None)
    value = snapshot(fact)
    value.pop("evolution")
    value["event"] = fact.event.to_payload() if fact.event else None
    value.update(dimension_evidence=evidence.to_payload(), _scene_name="合成场景",
        timing={"source_started_at": window.messages[0].occurred_at.isoformat(),
            "source_ended_at": window.messages[0].occurred_at.isoformat(),
            "source_time_complete": True},
        verified_source_receipt=[evidence.candidate_sha256, evidence.window_sha256, "any", False])
    result = {"accepted": [value], "rejected_count": 0, "extraction_completed": True,
        "failure_kind": None, "failure_reason": None, "candidate_trace_ids": [str(uuid4())],
        "model_accounting_owner": "typescript", "model_call_ids": [str(uuid4()), str(uuid4())],
        "a_execution_id": str(uuid4()), "a_input_sha256": "a" * 64, "a_rule_version": "b" * 64}
    return window, result


class ExtractionRemoteDecodeTest(unittest.TestCase):
    def test_valid_result_binds_actual_sources_and_preserves_accounting_identity(self):
        window, value = fixture()
        decoded = decode_extraction_outcome(value, window)
        self.assertTrue(decoded.accepted[0].dimension_evidence.source_bound)
        self.assertEqual(decoded.accepted[0].verified_source_receipt,
            tuple(value["accepted"][0]["verified_source_receipt"]))
        self.assertEqual(str(decoded.a_execution_id), value["a_execution_id"])
        self.assertEqual(decoded.model_accounting_owner, "typescript")
        self.assertEqual(decoded.accepted[0].timing.source_started_at.microsecond, 123456)

    def test_version_one_event_accepts_only_ts_default_extension_values(self):
        window, value = fixture(event=True)
        value["accepted"][0]["event"].update(occurrence_precision="unknown",
            occurrence_expression=None, anchor_message_id=None)
        decoded = decode_extraction_outcome(value, window)
        self.assertEqual(decoded.accepted[0].event.version, 1)
        self.assertEqual(decoded.accepted[0].event.stage, EventStage.PLANNED)
        value["accepted"][0]["event"]["occurrence_precision"] = "day"
        with self.assertRaises(ExtractionRemoteInvalidResponse):
            decode_extraction_outcome(value, window)

    def test_tampered_sources_hashes_and_execution_identity_are_rejected(self):
        window, original = fixture()
        mutations = [
            lambda item: item["accepted"][0]["dimension_evidence"].update(candidate_sha256="c" * 64),
            lambda item: item["accepted"][0]["dimension_evidence"].update(window_sha256="c" * 64),
            lambda item: item["accepted"][0]["dimension_evidence"].update(source_bound=True),
            lambda item: item["accepted"][0]["dimension_evidence"]["scope"].update(contact_id=str(uuid4())),
            lambda item: item["accepted"][0]["dimension_evidence"]["messages"][0].update(source_state_sha256="c" * 64),
            lambda item: item["accepted"][0]["timing"].update(source_time_complete=False),
            lambda item: item["accepted"][0].update(confidence=True),
            lambda item: item["accepted"][0].update(source_message_ids=[str(uuid4())]),
            lambda item: item["accepted"][0]["verified_source_receipt"].__setitem__(3, 0),
            lambda item: item.update(a_execution_id="invalid"),
            lambda item: item.update(a_input_sha256="x" * 64),
            lambda item: item.update(a_rule_version="c" * 63),
            lambda item: item.update(candidate_trace_ids=[]),
            lambda item: item.update(model_call_ids=[item["model_call_ids"][0]] * 2),
            lambda item: item.update(model_accounting_owner="python"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = deepcopy(original)
                mutate(value)
                with self.assertRaises(ExtractionRemoteInvalidResponse):
                    decode_extraction_outcome(value, window)
        changed = replace(window, messages=(replace(window.messages[0], text="已修改的合成来源。"),))
        with self.assertRaises(ExtractionRemoteInvalidResponse):
            decode_extraction_outcome(original, changed)


@contextmanager
def serve(value, *, blocked=None, arrived=None):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.headers.get("Authorization"),
                json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            if arrived is not None:
                arrived.set()
            if blocked is not None:
                blocked.wait(3)
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        if blocked is not None:
            blocked.set()
        server.shutdown()
        server.server_close()
        thread.join(2)


class ExtractionRemoteTransportTest(unittest.TestCase):
    def test_flow_sends_only_current_task_trace_and_batch_identity(self):
        from notalone.application.extraction_remote import RemoteExtractionRuntime
        window, result = fixture()
        claim = {"task_id": str(uuid4()), "step_id": str(uuid4()), "step_name": "extract_memory",
            "worker_id": str(uuid4()), "lease_generation": 1}
        batch = hashlib.sha256(str(window.messages[0].message_id).encode()).hexdigest()
        request_id = uuid5(NAMESPACE_URL, f"notalone:extraction:{claim['task_id']}:{batch}")
        trace_id = uuid4()
        control = SharedModelPriorityControl(socket_path="synthetic-unused", token="x" * 32)
        with serve({"outcome": result}) as (url, requests):
            runtime = RemoteExtractionRuntime(url=url, token="t" * 32, historical_runtime=object())
            with physical_model_task(control, request_id=request_id, owner_id=window.owner_id,
                    contact_id=window.contact_id, claim=claim):
                with TraceSession(object(), ContactScope(window.owner_id, window.contact_id), trace_id):
                    actual = ExtractionFlow(runtime=runtime).run(window)
            runtime.close()
        self.assertEqual(actual.model_accounting_owner, "typescript")
        self.assertEqual(requests, [("/internal/extraction/run", "Bearer " + "t" * 32,
            {"owner_id": str(window.owner_id), "contact_id": str(window.contact_id),
             "trace_id": str(trace_id), "batch_key": batch, "claim": claim})])

    def test_close_interrupts_pending_response_without_http_retry_or_fallback(self):
        from notalone.application.extraction_remote import RemoteExtractionRuntime, ExtractionRemoteUnavailable
        window, result = fixture()
        claim = {"task_id": str(uuid4()), "step_id": str(uuid4()), "step_name": "extract_memory",
            "worker_id": str(uuid4()), "lease_generation": 1}
        batch = hashlib.sha256(str(window.messages[0].message_id).encode()).hexdigest()
        request_id = uuid5(NAMESPACE_URL, f"notalone:extraction:{claim['task_id']}:{batch}")
        control = SharedModelPriorityControl(socket_path="synthetic-unused", token="x" * 32)
        blocked, arrived, failed = threading.Event(), threading.Event(), []
        def work():
            try:
                ExtractionFlow(runtime=runtime).run(window)
            except Exception as error:
                failed.append(error)
        with serve({"outcome": result}, blocked=blocked, arrived=arrived) as (url, requests):
            runtime = RemoteExtractionRuntime(url=url, token="t" * 32, historical_runtime=object(), timeout=2)
            with physical_model_task(control, request_id=request_id, owner_id=window.owner_id,
                    contact_id=window.contact_id, claim=claim):
                with TraceSession(object(), ContactScope(window.owner_id, window.contact_id), uuid4()):
                    context = copy_context()
                    thread = threading.Thread(target=lambda: context.run(work))
                    thread.start()
                    self.assertTrue(arrived.wait(1))
                    runtime.close()
                    thread.join(1)
                    self.assertFalse(thread.is_alive())
            self.assertEqual(len(requests), 1)
        self.assertEqual(len(failed), 1)
        self.assertIsInstance(failed[0], ExtractionRemoteUnavailable)

    def test_missing_task_scope_is_rejected_before_any_http(self):
        from notalone.application.extraction_remote import RemoteExtractionRuntime, ExtractionRemoteUnavailable
        window, result = fixture()
        with serve({"outcome": result}) as (url, requests):
            runtime = RemoteExtractionRuntime(url=url, token="t" * 32, historical_runtime=object())
            try:
                with self.assertRaises(ExtractionRemoteUnavailable):
                    runtime.run_remote_flow(window)
                self.assertEqual(requests, [])
            finally:
                runtime.close()
