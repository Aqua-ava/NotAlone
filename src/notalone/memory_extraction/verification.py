"""来源语义核验的模型边界与确定性证据契约。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from notalone.memory_trace.context import current_trace, record

MAX_SOURCE_VERIFICATION_CANDIDATES = 60


class SourceVerificationVerdict(StrEnum):
    """原话对候选主张的支持程度；不代表现实世界真假。"""

    SUPPORTED = "supported"
    UNCERTAIN = "uncertain"
    UNSUPPORTED = "unsupported"


class SourceVerificationIssue(StrEnum):
    """允许保留的来源语义阻塞原因，不接收任意模型理由或正文。"""

    MEANING = "meaning"
    SUBJECT = "subject"
    NEGATION = "negation"
    DEGREE = "degree"
    QUANTITY = "quantity"
    CONDITION = "condition"
    TIME = "time"
    PRAGMATICS = "pragmatics"
    DISCONNECTED_CONTEXT = "disconnected_context"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True, slots=True)
class EvidenceQuote:
    """可回指原始消息的逐字证据；提取追踪按 ADR-037 受控保存副本。"""

    message_id: UUID
    quote: str


@dataclass(frozen=True, slots=True)
class SourceVerificationResult:
    """已通过确定性契约校验的一条核验结果。"""

    candidate_index: int
    verdict: SourceVerificationVerdict
    issues: tuple[SourceVerificationIssue, ...]
    evidence: tuple[EvidenceQuote, ...]


class SourceVerificationRuntime(Protocol):
    """在同一有界窗口内核验原候选，不修改候选或产生写入动作。"""

    def verify(
        self,
        *,
        window: ExtractionWindow,
        facts: tuple[ExtractedFact, ...],
    ) -> tuple[dict[str, Any], ...]: ...


def validate_source_verification(
    payloads: object,
    *,
    window: ExtractionWindow,
    facts: tuple[ExtractedFact, ...],
) -> tuple[SourceVerificationResult, ...]:
    """整批校验覆盖、受控结果与真实来源片段，任何非法输出都安全停止。"""

    started_at = datetime.now(timezone.utc)
    coverage_valid = isinstance(payloads, tuple) and len(payloads) == len(
        facts
    )
    _record_contract(
        "coverage",
        coverage_valid,
        started_at=started_at,
        actual_count=len(payloads) if isinstance(payloads, tuple) else None,
        expected_count=len(facts),
    )
    if not coverage_valid:
        raise ExtractionInvalidOutputError("来源核验结果不符合证据契约。")
    assert isinstance(payloads, tuple)
    messages = {message.message_id: message for message in window.messages}
    results: dict[int, SourceVerificationResult] = {}
    try:
        for position, payload in enumerate(payloads):
            check = "payload_fields"
            started_at = datetime.now(timezone.utc)
            fields_valid = isinstance(payload, dict) and set(payload) == {
                "candidate_index",
                "verdict",
                "issues",
                "evidence",
            }
            _record_contract(
                check,
                fields_valid,
                candidate_index=position,
                started_at=started_at,
            )
            if not fields_valid:
                raise ValueError
            index = payload["candidate_index"]
            check = "candidate_index"
            started_at = datetime.now(timezone.utc)
            index_valid = (
                type(index) is int
                and 0 <= index < len(facts)
                and index not in results
            )
            _record_contract(
                check,
                index_valid,
                candidate_index=position,
                started_at=started_at,
                actual_index=index,
            )
            if not index_valid:
                raise ValueError
            check = "verdict_enum"
            verdict = SourceVerificationVerdict(payload["verdict"])
            raw_issues = payload["issues"]
            raw_evidence = payload["evidence"]
            check = "issues_and_evidence_arrays"
            started_at = datetime.now(timezone.utc)
            arrays_valid = isinstance(raw_issues, list) and isinstance(
                raw_evidence, list
            )
            _record_contract(
                check,
                arrays_valid,
                candidate_index=index,
                started_at=started_at,
            )
            if not arrays_valid:
                raise ValueError
            check = "issue_enum"
            issues = tuple(
                SourceVerificationIssue(item) for item in raw_issues
            )
            check = "verdict_issues_consistency"
            started_at = datetime.now(timezone.utc)
            issues_valid = not (
                verdict is SourceVerificationVerdict.SUPPORTED
                and issues
                or verdict is not SourceVerificationVerdict.SUPPORTED
                and not issues
            )
            _record_contract(
                check,
                issues_valid,
                candidate_index=index,
                started_at=started_at,
                verdict=verdict,
                issues=issues,
            )
            if not issues_valid:
                raise ValueError
            fact = facts[index]
            evidence: list[EvidenceQuote] = []
            for evidence_index, item in enumerate(raw_evidence):
                check = "evidence_fields"
                started_at = datetime.now(timezone.utc)
                evidence_valid = isinstance(item, dict) and set(item) == {
                    "message_id",
                    "quote",
                }
                _record_contract(
                    check,
                    evidence_valid,
                    candidate_index=index,
                    started_at=started_at,
                    evidence_index=evidence_index,
                )
                if not evidence_valid:
                    raise ValueError
                check = "message_id_string"
                if not isinstance(item["message_id"], str):
                    raise ValueError
                check = "message_id_uuid"
                message_id = UUID(item["message_id"])
                quote = item["quote"]
                check = "quote_in_message"
                started_at = datetime.now(timezone.utc)
                quote_valid = (
                    message_id in fact.source_message_ids
                    and message_id in messages
                    and isinstance(quote, str)
                    and bool(quote.strip())
                    and quote in messages[message_id].text
                )
                _record_contract(
                    check,
                    quote_valid,
                    candidate_index=index,
                    started_at=started_at,
                    evidence_index=evidence_index,
                    message_id=message_id,
                    quote=quote,
                    belongs_to_direct_sources=message_id
                    in fact.source_message_ids,
                    belongs_to_window=message_id in messages,
                    first_matching_offset=(
                        messages[message_id].text.find(quote)
                        if quote_valid
                        else None
                    ),
                    matching_kind="substring_presence",
                )
                if not quote_valid:
                    raise ValueError
                evidence.append(
                    EvidenceQuote(message_id=message_id, quote=quote)
                )
            check = "supported_target_evidence"
            started_at = datetime.now(timezone.utc)
            target_valid = not (
                verdict is SourceVerificationVerdict.SUPPORTED
                and (
                    not evidence
                    or not any(
                        item.message_id in window.target_message_id_set
                        for item in evidence
                    )
                )
            )
            _record_contract(
                check,
                target_valid,
                candidate_index=index,
                started_at=started_at,
                required=verdict is SourceVerificationVerdict.SUPPORTED,
            )
            if not target_valid:
                raise ValueError
            results[index] = SourceVerificationResult(
                candidate_index=index, verdict=verdict,
                issues=issues, evidence=tuple(evidence),
            )
    except (TypeError, ValueError, KeyError, AttributeError):
        _record_contract(
            check,
            False,
            candidate_index=position,
            started_at=started_at,
            status="failed",
        )
        raise ExtractionInvalidOutputError(
            "来源核验结果不符合证据契约。"
        ) from None
    return tuple(results[index] for index in range(len(facts)))


def _record_contract(
    check: str,
    passed: bool,
    *,
    candidate_index: int | None = None,
    started_at: datetime,
    **details: Any,
) -> None:
    trace = current_trace()
    candidate_trace_id = None
    if (
        trace is not None
        and candidate_index is not None
        and 0 <= candidate_index < len(trace.verification_candidate_ids)
    ):
        candidate_trace_id = trace.verification_candidate_ids[candidate_index]
    record(
        "verification_contract",
        {
            "check": check,
            "passed": passed,
            "candidate_index": candidate_index,
            **details,
        },
        candidate_trace_id=candidate_trace_id,
        started_at=started_at,
        status="passed" if passed else "failed",
    )
