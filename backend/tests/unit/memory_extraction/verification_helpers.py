"""仅用于合成夹具的来源核验 oracle，不代表生产语义判断能力。"""

from __future__ import annotations

from typing import Any

from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow


class SyntheticSupportingVerifier:
    """测试已约定正确的候选，返回其目标来源的真实逐字片段。"""

    def verify(
        self, *, window: ExtractionWindow, facts: tuple[ExtractedFact, ...]
    ) -> tuple[dict[str, Any], ...]:
        messages = {message.message_id: message for message in window.messages}
        return tuple({
            "candidate_index": index,
            "verdict": "supported",
            "issues": [],
            "evidence": [{
                "message_id": str(source_id),
                "quote": messages[source_id].text,
            } for source_id in fact.source_message_ids
                if source_id in window.target_message_id_set],
        } for index, fact in enumerate(facts))


class FixedSourceVerifier:
    """预置外部模型的合成结构化输出。"""

    def __init__(self, payloads: tuple[dict[str, Any], ...]) -> None:
        self.payloads = payloads
        self.calls: list[tuple[ExtractionWindow, tuple[ExtractedFact, ...]]] = []

    def verify(
        self, *, window: ExtractionWindow, facts: tuple[ExtractedFact, ...]
    ) -> tuple[dict[str, Any], ...]:
        self.calls.append((window, facts))
        return self.payloads


def verification_result(
    *,
    candidate_index: int = 0,
    verdict: str = "supported",
    issues: tuple[str, ...] = (),
    evidence: tuple[tuple[object, str], ...] = (),
) -> dict[str, Any]:
    return {
        "candidate_index": candidate_index,
        "verdict": verdict,
        "issues": list(issues),
        "evidence": [{"message_id": str(message_id), "quote": quote}
                     for message_id, quote in evidence],
    }


def failed_automatic_candidate(store, traces, scope):
    """从可删除追踪定位自动失败候选，继续核对已保存字段而不制造人工待办。"""
    from uuid import UUID
    detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
    identifiers = [event["payload"]["candidate_id"] for event in detail["events"]
                   if event["stage"] == "candidate_result"
                   and event["payload"].get("disposition") == "automatic_write_failed"]
    if len(identifiers) != 1 or store.list_pending_candidates(scope):
        raise AssertionError("预期单条已记录的自动失败，且没有新增人工待办。")
    candidate = store.get_candidate(scope=scope, candidate_id=UUID(str(identifiers[0])))
    if candidate.status.value != "rejected":
        raise AssertionError("自动失败候选必须已经终结。")
    return candidate
