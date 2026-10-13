"""从实际窗口装配逐字或获批有限语义依据；未能完整核清的关系保持未知。"""

from __future__ import annotations

from uuid import UUID

from notalone.memory.dimension_evidence import (
    DimensionEvidence, EvidenceMessage, MediaOrigin, MessageSpan, SemanticBasis,
    TextAlignment, TextSpan,
)
from notalone.memory.evidence_binding import (
    bind_dimension_evidence, candidate_digest, content_digest, fact_pragmatics,
    source_state_digest, window_digest,
)
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow
from notalone.memory_extraction.verification import (
    SourceVerificationMode, SourceVerificationResult, SourceVerificationVerdict,
)
from notalone.scopes import ContactScope


def build_dimension_evidence(
    window: ExtractionWindow,
    fact: ExtractedFact,
    verification: SourceVerificationResult | None,
) -> DimensionEvidence:
    """保存全部窗口依赖；新关系必须复核实际全文，不能仅从supported推断。"""

    scope = ContactScope(window.owner_id, window.contact_id)
    messages = []
    for message in window.messages:
        refs = []
        for snapshot in message.source_snapshots:
            try:
                refs.append((
                    UUID(str(snapshot["source_ref_id"])),
                    UUID(str(snapshot["source_id"])),
                ))
            except (ValueError, TypeError, KeyError):
                # 旧来源缺少受控定位时不能补造依据。
                refs = []
                break
        messages.append(EvidenceMessage(
            message.message_id, content_digest(message.text), len(message.text),
            message.sender.value, message.message_type, message.occurred_at,
            tuple(sorted(set(refs), key=lambda item: str(item[0]))),
            message.text_representation,
            source_state_digest(message.source_snapshots),
        ))
    metadata = tuple(messages)
    alignments = []
    if (
        verification is not None
        and verification.verdict is SourceVerificationVerdict.SUPPORTED
    ):
        for quote in verification.evidence:
            source = next(
                item for item in window.messages
                if item.message_id == quote.message_id
            )
            if quote.quote != source.text or fact.text != source.text:
                continue
            span = TextSpan(0, len(fact.text), content_digest(fact.text))
            alignments.append(TextAlignment(span, MessageSpan(source.message_id, span)))
    media = tuple(
        MediaOrigin(
            message.message_id, message.message_type, message.text_representation,
        )
        for message in window.messages
        if message.message_id in fact.source_message_ids
    )
    use_proof = (
        verification is not None
        and verification.verification_mode is SourceVerificationMode.NULLABLE_PROOF_V1
    )
    semantic_basis = None
    if (
        use_proof and verification is not None
        and verification.verdict is SourceVerificationVerdict.SUPPORTED
    ):
        from notalone.memory_extraction.source_proof import verify_proposal
        checked = verify_proposal(
            verification.proof, window=window, fact=fact,
            trusted_sources={item.message_id: item.text for item in window.messages},
        )
        if checked.status == "verified" and checked.semantic_basis is not None:
            semantic_basis = SemanticBasis.from_payload(checked.semantic_basis)
    evidence = DimensionEvidence(
        scope=scope, candidate_sha256=candidate_digest(fact),
        window_sha256=window_digest(scope, metadata), messages=metadata,
        pragmatics=fact_pragmatics(fact),
        paraphrase=tuple(alignments) if alignments else None,
        reference=None, media=media, reported=None,
        version=2 if use_proof else 1, semantic_basis=semantic_basis,
    )
    return bind_dimension_evidence(
        evidence, scope=scope, candidate=fact, messages=metadata,
        texts={item.message_id: item.text for item in window.messages},
        source_snapshots={
            item.message_id: item.source_snapshots for item in window.messages
        },
    )
