"""默认提取A段的宿主私有桥；原Worker、来源窗口和B段事务保持唯一。"""
from __future__ import annotations

from dataclasses import replace
from collections.abc import Mapping
import hashlib
import http.client
import json
import math
import re
import socket
import threading
from urllib.parse import urlsplit
from uuid import UUID, uuid5, NAMESPACE_URL

from notalone.application.model_priority import ModelWorkStopped
from notalone.application.model_transport_accounting import current_physical_task_metadata
from notalone.memory.conditions import MemoryConditions
from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.events import MemoryEvent
from notalone.memory.evidence_binding import bind_dimension_evidence
from notalone.memory.models import SourceDependencyMode
from notalone.memory.timing import MemoryTiming
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.flow import ExtractionOutcome, _to_fact
from notalone.memory_extraction.models import ExtractionFailureKind, ExtractionWindow
from notalone.memory_trace.context import current_trace
from notalone.scopes import ContactScope


class ExtractionRemoteUnavailable(ModelWorkStopped):
    """A段结果未能确认；停止原任务，不据此计为可跳过的模型坏输出。"""


class ExtractionRemoteInvalidResponse(ExtractionRemoteUnavailable):
    """宿主响应不符合原候选、来源或执行身份契约。"""


def _object(value: object, fields: set[str]) -> dict:
    if type(value) is not dict or set(value) != fields:
        raise ValueError("extraction_remote_fields_invalid")
    return value


def _uuid(value: object) -> UUID:
    if type(value) is not str or str(result := UUID(value)) != value:
        raise ValueError("extraction_remote_uuid_invalid")
    return result


def _hash(value: object) -> str:
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("extraction_remote_hash_invalid")
    return value


def _ids(value: object, *, maximum: int) -> tuple[UUID, ...]:
    if type(value) is not list or len(value) > maximum:
        raise ValueError("extraction_remote_ids_invalid")
    result = tuple(_uuid(item) for item in value)
    if len(set(result)) != len(result):
        raise ValueError("extraction_remote_ids_duplicate")
    return result


_FACT_FIELDS = {
    "text", "category", "subject", "topic", "source_message_ids", "confidence",
    "risk_flags", "valid_at", "invalid_at", "speech_act", "assertion_status",
    "figurative_type", "alternatives", "interpretation_reason", "timing",
    "event", "conditions", "requires_all_sources", "source_dependency_mode",
    "_scene_name", "dimension_evidence", "verified_source_receipt",
}


def _event(value: object) -> MemoryEvent | None:
    # TS内部事件统一带v2扩展槽；v1只允许其未知默认值，不借此升级原合同。
    extensions = {"occurrence_precision", "occurrence_expression", "anchor_message_id"}
    if type(value) is dict and value.get("version") == 1 and extensions & value.keys():
        if (not extensions <= value.keys() or value["occurrence_precision"] != "unknown"
                or value["occurrence_expression"] is not None or value["anchor_message_id"] is not None):
            raise ValueError("extraction_remote_event_invalid")
        value = {key: item for key, item in value.items() if key not in extensions}
    return MemoryEvent.from_payload(value)


def _fact(value: object, window: ExtractionWindow):
    data = _object(value, _FACT_FIELDS)
    source_ids = _ids(data["source_message_ids"], maximum=600)
    if (not source_ids or not set(source_ids) <= window.message_id_set
            or not set(source_ids) & window.target_message_id_set
            or type(data["requires_all_sources"]) is not bool
            or data["source_dependency_mode"] != "any"
            or type(data["_scene_name"]) is not str or not data["_scene_name"].strip()
            or type(data["confidence"]) not in (float, int)
            or not math.isfinite(data["confidence"])):
        raise ValueError("extraction_remote_candidate_invalid")
    # 原解析器保留受控枚举、非空文本和有效期校验；核验后的event不能当提案清空。
    proposal = {**data, "event": None, "conditions": None,
        "_requires_all_sources": data["requires_all_sources"]}
    fact = replace(_to_fact(proposal),
        event=_event(data["event"]),
        conditions=MemoryConditions.from_payload(data["conditions"]),
        source_dependency_mode=SourceDependencyMode.ANY)
    references = [ref for condition in fact.conditions.items for ref in condition.evidence] if fact.conditions else []
    if fact.event:
        references += [*fact.event.stage_evidence, *fact.event.occurrence_evidence]
        if fact.event.anchor_message_id is not None and fact.event.anchor_message_id not in source_ids:
            raise ValueError("extraction_remote_event_anchor_invalid")
    messages = {item.message_id: item for item in window.messages}
    if any(ref.message_id not in source_ids or messages[ref.message_id].text_representation != "text"
           or ref.char_end > len(messages[ref.message_id].text) for ref in references):
        raise ValueError("extraction_remote_positions_invalid")
    timing = _object(data["timing"], {"source_started_at", "source_ended_at", "source_time_complete"})
    actual_timing = MemoryTiming.from_source_times([messages[item].occurred_at for item in source_ids])
    parsed_timing = MemoryTiming.from_payload({**timing, "recorded_at": None})
    if parsed_timing != actual_timing:
        raise ValueError("extraction_remote_timing_invalid")
    fact = replace(fact, timing=actual_timing)
    evidence = DimensionEvidence.from_payload(data["dimension_evidence"])
    expected = build_dimension_evidence(window, fact, None)
    if (evidence.version != 1 or evidence.scope != expected.scope
            or evidence.candidate_sha256 != expected.candidate_sha256
            or evidence.window_sha256 != expected.window_sha256
            or evidence.messages != expected.messages or evidence.pragmatics != expected.pragmatics
            or evidence.reference is not None or evidence.reported is not None
            or evidence.media != expected.media):
        raise ValueError("extraction_remote_evidence_invalid")
    rebound = bind_dimension_evidence(evidence, scope=ContactScope(window.owner_id, window.contact_id),
        candidate=fact, messages=expected.messages,
        texts={item.message_id: item.text for item in window.messages},
        source_snapshots={item.message_id: item.source_snapshots for item in window.messages})
    if expected.source_bound and not rebound.source_bound:
        raise ValueError("extraction_remote_evidence_invalid")
    receipt = data["verified_source_receipt"]
    if receipt is not None:
        if (type(receipt) is not list or len(receipt) != 4
                or type(receipt[3]) is not bool or not rebound.source_bound
                or receipt != [rebound.candidate_sha256, rebound.window_sha256,
                    fact.source_dependency_mode.value, fact.requires_all_sources]):
            raise ValueError("extraction_remote_receipt_invalid")
        receipt = tuple(receipt)
    return replace(fact, dimension_evidence=rebound, verified_source_receipt=receipt)


def decode_extraction_outcome(value: object, window: ExtractionWindow) -> ExtractionOutcome:
    """从私有JSON恢复原领域对象；持久化source_bound从不作为信任输入。"""
    try:
        data = _object(value, {"accepted", "rejected_count", "extraction_completed", "failure_kind",
            "failure_reason", "candidate_trace_ids", "model_accounting_owner", "model_call_ids",
            "a_execution_id", "a_input_sha256", "a_rule_version"})
        if (type(data["accepted"]) is not list or len(data["accepted"]) > 60
                or type(data["rejected_count"]) is not int or data["rejected_count"] < 0
                or type(data["extraction_completed"]) is not bool
                or data["model_accounting_owner"] != "typescript"):
            raise ValueError()
        candidate_ids = _ids(data["candidate_trace_ids"], maximum=60)
        call_ids = _ids(data["model_call_ids"], maximum=7)
        if len(candidate_ids) != len(data["accepted"]):
            raise ValueError()
        kind = None if data["failure_kind"] is None else ExtractionFailureKind(data["failure_kind"])
        reason = data["failure_reason"]
        if ((kind is None) != (reason is None) or reason is not None and (type(reason) is not str or not reason.strip())
                or kind is not None and data["accepted"]
                or kind is None and not data["extraction_completed"]):
            raise ValueError()
        return ExtractionOutcome(accepted=tuple(_fact(item, window) for item in data["accepted"]),
            rejected_count=data["rejected_count"], extraction_completed=data["extraction_completed"],
            failure_kind=kind, failure_reason=reason, candidate_trace_ids=candidate_ids,
            model_accounting_owner="typescript", model_call_ids=call_ids,
            a_execution_id=_uuid(data["a_execution_id"]), a_input_sha256=_hash(data["a_input_sha256"]),
            a_rule_version=_hash(data["a_rule_version"]))
    except (ValueError, TypeError, KeyError, OverflowError):
        raise ExtractionRemoteInvalidResponse("extraction_remote_response_invalid") from None


def _json_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("extraction_remote_duplicate_key")
        result[key] = value
    return result


class RemoteExtractionRuntime:
    """显式选择默认TS模式；历史教学profile由原适配器选择，不作失败回退。"""

    def __init__(self, *, url: str, token: str, historical_runtime,
                 owner_id: UUID | None = None, timeout: float = 600):
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"
                and parsed.port is not None and 1 <= parsed.port <= 65535
                and not parsed.username and not parsed.password and not parsed.path
                and not parsed.query and not parsed.fragment)
        except (ValueError, TypeError, AttributeError):
            valid = False
        if (not valid or type(token) is not str or len(token) < 32
                or any(ord(item) < 33 or ord(item) > 126 for item in token)
                or owner_id is not None and not isinstance(owner_id, UUID)
                or type(timeout) not in (int, float) or not 0 < timeout <= 900
                or historical_runtime is None):
            raise ValueError("extraction_remote_config_invalid")
        self._port, self._token, self._owner = parsed.port, token, owner_id
        self._timeout, self._historical = timeout, historical_runtime
        self._lock, self._closed, self._connections = threading.Lock(), False, set()

    @classmethod
    def from_environment(cls, environment: Mapping[str, str], *, historical_runtime,
                         owner_id: UUID | None = None):
        try:
            return cls(url=environment["NOTALONE_EXTRACTION_REMOTE_URL"],
                token=environment["NOTALONE_EXTRACTION_REMOTE_TOKEN"],
                historical_runtime=historical_runtime, owner_id=owner_id)
        except (KeyError, ValueError, TypeError):
            raise ExtractionRemoteUnavailable("extraction_remote_config_invalid") from None

    def for_prompt_profile(self, profile: str):
        select = getattr(self._historical, "for_prompt_profile", None)
        if not callable(select):
            raise ValueError("extraction_remote_historical_profile_unavailable")
        return select(profile)

    def extract(self, window: ExtractionWindow):
        raise ExtractionRemoteUnavailable("extraction_remote_flow_required")

    def run_remote_flow(self, window: ExtractionWindow) -> ExtractionOutcome:
        try:
            metadata, trace = current_physical_task_metadata(), current_trace()
            if (metadata is None or metadata["scope_kind"] != "contact"
                    or metadata["owner_id"] != window.owner_id or metadata["contact_id"] != window.contact_id
                    or self._owner is not None and self._owner != window.owner_id
                    or trace is None or trace.scope != ContactScope(window.owner_id, window.contact_id)):
                raise ValueError()
            claim = dict(metadata["claim"])
            _object(claim, {"task_id", "step_id", "step_name", "worker_id", "lease_generation"})
            for key in ("task_id", "step_id", "worker_id"):
                _uuid(claim[key])
            if (claim["step_name"] != "extract_memory" or type(claim["lease_generation"]) is not int
                    or claim["lease_generation"] < 1):
                raise ValueError()
            targets = window.target_message_ids or tuple(item.message_id for item in window.messages)
            batch_key = hashlib.sha256("|".join(str(item) for item in targets).encode()).hexdigest()
            if metadata["request_id"] != uuid5(NAMESPACE_URL, f"notalone:extraction:{claim['task_id']}:{batch_key}"):
                raise ValueError()
            payload = {"owner_id": str(window.owner_id), "contact_id": str(window.contact_id),
                "trace_id": str(trace.trace_id), "batch_key": batch_key, "claim": claim}
        except (ValueError, TypeError, KeyError):
            raise ExtractionRemoteUnavailable("extraction_remote_scope_invalid") from None
        result = self._request(payload)
        try:
            _object(result, {"outcome"})
        except ValueError:
            raise ExtractionRemoteInvalidResponse("extraction_remote_response_invalid") from None
        return decode_extraction_outcome(result["outcome"], window)

    @staticmethod
    def _interrupt(connection: http.client.HTTPConnection) -> None:
        current_socket = connection.sock
        if current_socket is not None:
            try:
                current_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    def _request(self, payload: dict) -> dict:
        connection = http.client.HTTPConnection("127.0.0.1", self._port, timeout=self._timeout)
        connection.auto_open = 0
        with self._lock:
            if self._closed:
                raise ExtractionRemoteUnavailable("extraction_remote_closed")
            self._connections.add(connection)
        expired = threading.Event()
        def interrupt():
            expired.set()
            self._interrupt(connection)
        timer = threading.Timer(self._timeout, interrupt)
        timer.daemon = True
        timer.start()
        try:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            if len(body) > 32768:
                raise ValueError()
            connection.connect()
            with self._lock:
                if self._closed or expired.is_set():
                    raise ExtractionRemoteUnavailable("extraction_remote_closed")
            connection.request("POST", "/internal/extraction/run", body=body,
                headers={"Authorization": "Bearer " + self._token, "Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(4194305)
            if (len(raw) > 4194304
                    or response.getheader("Content-Type", "").split(";")[0].strip() != "application/json"):
                raise ExtractionRemoteInvalidResponse("extraction_remote_response_invalid")
            result = json.loads(raw.decode("utf-8"), object_pairs_hook=_json_pairs,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if response.status != 200:
                raise ExtractionRemoteUnavailable("extraction_remote_run_unconfirmed")
            with self._lock:
                if self._closed or expired.is_set():
                    raise ExtractionRemoteUnavailable("extraction_remote_closed")
            return result
        except (OSError, http.client.HTTPException, ValueError, TypeError, UnicodeError):
            raise ExtractionRemoteUnavailable("extraction_remote_transport_unconfirmed") from None
        finally:
            timer.cancel()
            with self._lock:
                self._connections.discard(connection)
            connection.close()
            timer.join(1)

    def close(self) -> None:
        """只中断本适配器登记的连接；宿主停止须在等待Worker结束之前调用。"""
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
        for connection in connections:
            self._interrupt(connection)
