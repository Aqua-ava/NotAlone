"""给复核提供有界字面差分，不从差分推断意图或替模型作语义裁决。"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import Any


def literal_change_evidence(draft: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [_candidate_changes(draft, candidate) for candidate in candidates]


def _candidate_changes(draft: str, candidate: dict[str, Any]) -> dict[str, Any]:
    result = {"candidate_number": candidate["candidate_number"],
              "scope": "draft_text_to_candidate_text", "status": "unavailable", "changes": []}
    text = candidate["text"]
    # 限定CPU与输入增量；超限不截断原稿/候选，也不把未计算伪装成没有改动。
    if max(len(draft), len(text)) > 2048:
        return {**result, "reason": "comparison_limit"}
    changes = [{"operation": operation, "draft_fragment": draft[left:right],
                "candidate_fragment": text[start:end]}
               for operation, left, right, start, end in SequenceMatcher(
                   None, draft, text, autojunk=False).get_opcodes() if operation != "equal"]
    if len(changes) > 64:
        return {**result, "reason": "comparison_limit"}
    return {**result, "status": "computed", "changes": changes}
