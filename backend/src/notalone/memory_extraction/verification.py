"""来源语义核验的模型边界与确定性证据契约。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow


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
    """当前运行内可回指原始消息的逐字证据，不持久化正文副本。"""

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

    if not isinstance(payloads, tuple) or len(payloads) != len(facts):
        raise ExtractionInvalidOutputError("来源核验结果不符合证据契约。")
    messages = {message.message_id: message for message in window.messages}
    results: dict[int, SourceVerificationResult] = {}
    try:
        for payload in payloads:
            if not isinstance(payload, dict) or set(payload) != {
                "candidate_index", "verdict", "issues", "evidence",
            }:
                raise ValueError
            index = payload["candidate_index"]
            if (
                type(index) is not int or not 0 <= index < len(facts)
                or index in results
            ):
                raise ValueError
            verdict = SourceVerificationVerdict(payload["verdict"])
            raw_issues = payload["issues"]
            raw_evidence = payload["evidence"]
            if not isinstance(raw_issues, list) or not isinstance(raw_evidence, list):
                raise ValueError
            issues = tuple(SourceVerificationIssue(item) for item in raw_issues)
            if (
                verdict is SourceVerificationVerdict.SUPPORTED and issues
                or verdict is not SourceVerificationVerdict.SUPPORTED and not issues
            ):
                raise ValueError
            fact = facts[index]
            evidence: list[EvidenceQuote] = []
            for item in raw_evidence:
                if not isinstance(item, dict) or set(item) != {"message_id", "quote"}:
                    raise ValueError
                if not isinstance(item["message_id"], str):
                    raise ValueError
                message_id = UUID(item["message_id"])
                quote = item["quote"]
                if (
                    message_id not in fact.source_message_ids
                    or message_id not in messages
                    or not isinstance(quote, str) or not quote.strip()
                    or quote not in messages[message_id].text
                ):
                    raise ValueError
                evidence.append(EvidenceQuote(message_id=message_id, quote=quote))
            if verdict is SourceVerificationVerdict.SUPPORTED and (
                not evidence or not any(
                    item.message_id in window.target_message_id_set
                    for item in evidence
                )
            ):
                raise ValueError
            results[index] = SourceVerificationResult(
                candidate_index=index, verdict=verdict,
                issues=issues, evidence=tuple(evidence),
            )
    except (TypeError, ValueError, KeyError, AttributeError):
        raise ExtractionInvalidOutputError("来源核验结果不符合证据契约。") from None
    return tuple(results[index] for index in range(len(facts)))
