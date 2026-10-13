"""把无正文维度依据绑定到实际候选及同范围当前来源。"""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import re
from typing import Any, Iterable, Mapping, TYPE_CHECKING

from notalone.memory.dimension_evidence import (
    DimensionEvidence, EvidenceMessage, evidence_timestamp,
)
from notalone.memory.pragmatics import PragmaticSnapshot
from notalone.scopes import ContactScope

if TYPE_CHECKING:
    from uuid import UUID
    from notalone.memory.models import MemoryCandidate
    from notalone.memory_extraction.models import ExtractedFact


def content_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_digest(value: object) -> str:
    return content_digest(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ))


def candidate_digest(value: MemoryCandidate | ExtractedFact) -> str:
    """只含候选与 Fact 共有的采纳字段；不含保存时间或状态。"""

    from notalone.memory.models import MemoryCandidate

    source_ids = (
        value.source_ids if isinstance(value, MemoryCandidate)
        else value.source_message_ids
    )
    return _canonical_digest({
        "text": value.text, "category": value.category.value,
        "topic": value.topic.value, "subject": value.subject.value,
        "source_ids": sorted(str(item) for item in source_ids),
        "valid_at": evidence_timestamp(value.valid_at),
        "invalid_at": evidence_timestamp(value.invalid_at),
        "confidence": value.confidence,
        "risk_flags": list(value.risk_flags), "alternatives": list(value.alternatives),
        "interpretation_reason": value.interpretation_reason,
    })


def fact_pragmatics(value: ExtractedFact) -> PragmaticSnapshot:
    """提取事实的实际标签；持久候选没有这些字段，不能替其推断。"""

    return PragmaticSnapshot(
        value.speech_act, value.assertion_status, value.figurative_type,
    )


def source_state_digest(snapshots: Iterable[Mapping[str, object]]) -> str | None:
    """仅摘要既有来源指纹及引用载荷；缺字段保持未知，不读源文件。"""

    rows = []
    for item in snapshots:
        names = {
            "source_ref_id", "source_id", "source_kind", "locator",
            "raw_payload", "source_content_sha256",
        }
        if not names <= set(item):
            return None
        kind, digest = item["source_kind"], item["source_content_sha256"]
        if not isinstance(kind, str) or kind not in {
            "source_document", "local_wechat_observation",
        }:
            return None
        if (
            not isinstance(item["locator"], str)
            or not item["locator"].strip()
            or not isinstance(item["raw_payload"], dict)
        ):
            return None
        if kind == "source_document" and (
            not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        ):
            return None
        rows.append({name: item[name] for name in names})
    if not rows:
        return None
    try:
        return _canonical_digest(sorted(
            rows, key=lambda row: str(row["source_ref_id"]),
        ))
    except (TypeError, ValueError):
        return None


def window_digest(scope: ContactScope, messages: tuple[EvidenceMessage, ...]) -> str:
    return _canonical_digest({
        "owner_id": str(scope.owner_id), "contact_id": str(scope.contact_id),
        "messages": [item.to_payload() for item in messages],
    })


def bind_dimension_evidence(
    evidence: DimensionEvidence,
    *,
    scope: ContactScope,
    candidate: MemoryCandidate | ExtractedFact,
    messages: tuple[EvidenceMessage, ...],
    texts: Mapping[UUID, str],
    source_snapshots: Mapping[UUID, tuple[dict[str, Any], ...]] | None = None,
) -> DimensionEvidence:
    """纯校验当前来源；任何摘要、片段、引用或范围变化保留未知。"""

    from notalone.memory.models import MemoryCandidate

    result = replace(evidence)
    current = (
        evidence.scope == scope
        and evidence.candidate_sha256 == candidate_digest(candidate)
        and (
            isinstance(candidate, MemoryCandidate)
            or evidence.pragmatics == fact_pragmatics(candidate)
        )
        and evidence.messages == messages
        and evidence.window_sha256 == window_digest(scope, messages)
        and set(texts) == {item.message_id for item in messages}
        and all(
            item.source_refs and item.source_state_sha256 is not None
            for item in messages
        )
    )
    if not current:
        return result
    for item in messages:
        text = texts[item.message_id]
        if item.text_length != len(text) or item.text_sha256 != content_digest(text):
            return result
    for anchor in evidence.message_spans:
        text = texts[anchor.message_id]
        if (
            content_digest(text[anchor.span.start:anchor.span.end])
            != anchor.span.sha256
        ):
            return result
    for alignment in evidence.paraphrase or ():
        span = alignment.candidate
        if (
            span.end > len(candidate.text)
            or content_digest(candidate.text[span.start:span.end]) != span.sha256
        ):
            return result
    if evidence.semantic_basis is not None:
        from notalone.memory_extraction.source_proof import reverify_basis
        from notalone.memory_extraction.models import (
            ExtractedFact, ExtractionWindow, MessageRef, MessageSender,
        )

        basis = evidence.semantic_basis
        source_ids = (
            candidate.source_ids if isinstance(candidate, MemoryCandidate)
            else candidate.source_message_ids
        )
        if (
            evidence.pragmatics is None
            or source_snapshots is None
            or set(source_snapshots) != set(texts)
            or any(anchor.message_id not in source_ids for anchor in basis.message_spans)
        ):
            return result
        assert source_snapshots is not None
        if any(
            source_state_digest(source_snapshots[item.message_id])
            != item.source_state_sha256 for item in messages
        ):
            return result
        for span in basis.candidate_spans:
            if (
                span.end > len(candidate.text)
                or content_digest(candidate.text[span.start:span.end]) != span.sha256
            ):
                return result
        try:
            window = ExtractionWindow(scope.owner_id, scope.contact_id, tuple(
                MessageRef(
                    item.message_id, texts[item.message_id], MessageSender(item.sender),
                    item.occurred_at, source_snapshots[item.message_id],
                    message_type=item.message_type,
                    text_representation=item.text_representation,
                ) for item in messages
            ))
            fact = candidate if isinstance(candidate, ExtractedFact) else ExtractedFact(
                text=candidate.text, category=candidate.category,
                subject=candidate.subject, topic=candidate.topic,
                source_message_ids=candidate.source_ids,
                confidence=candidate.confidence if candidate.confidence is not None else 0.0,
                risk_flags=candidate.risk_flags, valid_at=candidate.valid_at,
                invalid_at=candidate.invalid_at, alternatives=candidate.alternatives,
                interpretation_reason=candidate.interpretation_reason,
                speech_act=evidence.pragmatics.speech_act,
                assertion_status=evidence.pragmatics.assertion_status,
                figurative_type=evidence.pragmatics.figurative_type,
            )
            checked = reverify_basis(basis.to_payload(), window, fact, texts)
        except (TypeError, ValueError):
            return result
        if checked.status != "verified" or checked.semantic_basis != basis.to_payload():
            return result
    object.__setattr__(result, "source_bound", True)
    return result
