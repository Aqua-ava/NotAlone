"""前台会话绑定匹配器的纯逻辑测试，不访问数据库或 CLI。"""

from __future__ import annotations

import unittest
from datetime import datetime
from uuid import uuid4

from notalone.conversation import (
    BindingMatchKind,
    BindingMatchReason,
    FrontSessionEvidence,
    StoredBindingEvidence,
    match_front_session,
    summarize_evidence,
)
from notalone.wechat_cli import ChatCandidate


def _timestamp(hour: int, minute: int) -> int:
    return int(datetime(2026, 8, 23, hour, minute).timestamp())


def _candidate(
    username: str,
    display_name: str,
    *,
    chat_type: str = "private",
    last_timestamp: int | None = None,
    summary: str | None = None,
) -> ChatCandidate:
    return ChatCandidate(
        username=username,
        display_name=display_name,
        match="exact",
        chat_type=chat_type,
        last_timestamp=last_timestamp,
        sort_timestamp=last_timestamp,
        source="sessions",
        summary=summary,
    )


class MatchFrontSessionTest(unittest.TestCase):
    def test_unreadable_display_name_is_unavailable(self) -> None:
        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="   "),
            candidates=(_candidate("wxid_a", "姐姐"),),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.UNAVAILABLE)
        self.assertEqual(decision.reason, BindingMatchReason.OBSERVATION_UNREADABLE)
        self.assertEqual(decision.candidates, ())

    def test_group_candidates_never_match(self) -> None:
        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐"),
            candidates=(_candidate("chatroom_1", "姐姐", chat_type="group"),),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.UNAVAILABLE)
        self.assertEqual(decision.reason, BindingMatchReason.NO_CANDIDATE)

    def test_unique_candidate_requires_first_binding_selection(self) -> None:
        candidate = _candidate("wxid_a", "姐姐")

        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐"),
            candidates=(candidate,),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.FIRST_BINDING_UNIQUE)
        self.assertEqual(decision.candidates, (candidate,))
        self.assertIsNone(decision.confirmed_binding_id)

    def test_same_name_candidates_require_one_time_selection(self) -> None:
        first = _candidate("wxid_a", "姐姐")
        second = _candidate("wxid_b", "姐姐")

        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐"),
            candidates=(first, second),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(
            decision.reason,
            BindingMatchReason.AMBIGUOUS_REQUIRES_SELECTION,
        )
        self.assertEqual(decision.candidates, (first, second))

    def test_time_and_preview_evidence_narrow_to_single_candidate(self) -> None:
        matching = _candidate(
            "wxid_a",
            "姐姐",
            last_timestamp=_timestamp(19, 59),
            summary="好的",
        )
        other = _candidate(
            "wxid_b",
            "姐姐",
            last_timestamp=_timestamp(9, 30),
            summary="明天见",
        )

        decision = match_front_session(
            evidence=FrontSessionEvidence(
                display_name="姐姐",
                last_time_text="19:59",
                preview_text="好的",
            ),
            candidates=(matching, other),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.FIRST_BINDING_UNIQUE)
        self.assertEqual(decision.candidates, (matching,))

    def test_all_candidates_contradicting_evidence_is_unavailable(self) -> None:
        decision = match_front_session(
            evidence=FrontSessionEvidence(
                display_name="姐姐",
                last_time_text="19:59",
                preview_text="好的",
            ),
            candidates=(
                _candidate(
                    "wxid_a",
                    "姐姐",
                    last_timestamp=_timestamp(9, 30),
                    summary="明天见",
                ),
            ),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.UNAVAILABLE)
        self.assertEqual(decision.reason, BindingMatchReason.METADATA_MISMATCH)

    def test_relative_time_text_is_not_treated_as_contradiction(self) -> None:
        candidate = _candidate("wxid_a", "姐姐", last_timestamp=_timestamp(19, 59))

        decision = match_front_session(
            evidence=FrontSessionEvidence(
                display_name="姐姐",
                last_time_text="昨天",
            ),
            candidates=(candidate,),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.FIRST_BINDING_UNIQUE)

    def test_absolute_date_text_is_not_treated_as_contradiction(self) -> None:
        # “8月20日”这类纯日期含数字但不是时刻，不能用来反证候选。
        candidate = _candidate("wxid_a", "姐姐", last_timestamp=_timestamp(19, 59))

        decision = match_front_session(
            evidence=FrontSessionEvidence(
                display_name="姐姐",
                last_time_text="8月20日",
            ),
            candidates=(candidate,),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.FIRST_BINDING_UNIQUE)

    def test_stored_binding_with_same_name_confirms_automatically(self) -> None:
        binding_id = uuid4()
        candidate = _candidate("wxid_a", "姐姐")

        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐"),
            candidates=(candidate,),
            stored_bindings=(
                StoredBindingEvidence(
                    binding_id=binding_id,
                    conversation_locator="wxid_a",
                    display_name="姐姐",
                ),
            ),
        )

        self.assertEqual(decision.kind, BindingMatchKind.CONFIRMED)
        self.assertEqual(
            decision.reason,
            BindingMatchReason.CONFIRMED_ACTIVE_BINDING,
        )
        self.assertEqual(decision.confirmed_binding_id, binding_id)

    def test_renamed_binding_requires_one_time_reconfirmation(self) -> None:
        binding_id = uuid4()
        candidate = _candidate("wxid_a", "姐姐改名后")

        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐改名后"),
            candidates=(candidate, _candidate("wxid_b", "姐姐改名后")),
            stored_bindings=(
                StoredBindingEvidence(
                    binding_id=binding_id,
                    conversation_locator="wxid_a",
                    display_name="姐姐",
                ),
            ),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.BINDING_NAME_CHANGED)
        self.assertEqual(decision.candidates, (candidate,))
        self.assertIsNone(decision.confirmed_binding_id)

    def test_revoked_locator_is_not_treated_as_stored_binding(self) -> None:
        # 撤销后的绑定不会出现在 list_active_bindings 投影中；
        # 这里直接传入空投影验证不会自动通过。
        decision = match_front_session(
            evidence=FrontSessionEvidence(display_name="姐姐"),
            candidates=(_candidate("wxid_a", "姐姐"),),
            stored_bindings=(),
        )

        self.assertEqual(decision.kind, BindingMatchKind.NEEDS_SELECTION)
        self.assertEqual(decision.reason, BindingMatchReason.FIRST_BINDING_UNIQUE)


class SummarizeEvidenceTest(unittest.TestCase):
    def test_summary_never_contains_preview_plain_text(self) -> None:
        summary = summarize_evidence(
            FrontSessionEvidence(
                display_name="姐姐",
                last_time_text="19:59",
                preview_text="好的",
            )
        )

        self.assertEqual(summary.get("time_text"), "19:59")
        self.assertNotIn("好的", str(summary))
        self.assertEqual(len(summary.get("preview_digest", "")), 64)

    def test_empty_evidence_produces_empty_summary(self) -> None:
        summary = summarize_evidence(
            FrontSessionEvidence(display_name="姐姐")
        )

        self.assertEqual(dict(summary), {})


if __name__ == "__main__":
    unittest.main()
