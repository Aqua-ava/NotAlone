"""同图尾部证据与 ADR-076 通用名单核验；仅触达只读元数据边界。"""

from __future__ import annotations

import json
import time
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from notalone.conversation.models import ConversationBindingStatus
from notalone.front_sync.emoji_tail import has_supported_emoji_suffix
from notalone.front_sync.foreground_locator import ForegroundLocator
from notalone.front_sync.probe_adapter import MacosFrontSessionProbe, ProbeAdapterError
from notalone.persistence.conversation_repository import PersistedConversationBinding
from notalone.scopes import ContactScope
from notalone.wechat_cli.models import ChatCandidate


OWNER = UUID("00000000-0000-4000-8000-000000000101")
CONTACT = UUID("00000000-0000-4000-8000-000000000102")
BINDING = UUID("00000000-0000-4000-8000-000000000103")


def envelope() -> dict:
    return {
        "ok": True, "wechat_in_front": True, "capture_version": "automatic-header-v4",
        "display_name": "合成學", "captured_at": datetime.now(timezone.utc).isoformat(),
        "quality": {"layout_verified": True, "display_name_confidence": 0.3, "name_complete": True},
        "text_fallback": {"version": "isolated-color-tail-v1", "text": "合成", "confidence": 0.95,
                          "text_complete": True, "mask_verified": True},
    }


def candidate(name: str = "合成🐯", username: str = "synthetic_01", kind: str = "private") -> ChatCandidate:
    return ChatCandidate(username, name, None, kind, None, None, None)


def binding(name: str = "合成🐯") -> PersistedConversationBinding:
    now = datetime.now(timezone.utc)
    return PersistedConversationBinding(
        BINDING, ContactScope(OWNER, CONTACT), "wechat", "synthetic-account", "synthetic_01",
        ConversationBindingStatus.ACTIVE, now, now, now, display_name=name,
    )


class EmojiFallbackTest(unittest.TestCase):
    def parse(self, payload: dict):
        return MacosFrontSessionProbe(runner=lambda command: SimpleNamespace(
            returncode=0, stdout=json.dumps(payload), stderr="",
        )).observe_fresh(timeout_seconds=0.9)

    def locate(self, payload=None, *, candidates=None, bindings=None, cli_error=None,
               check_current=None, deadline=None):
        observation = self.parse(envelope() if payload is None else payload)
        self.cli_calls = []
        self.binding_calls = []

        def sessions(**kwargs):
            self.cli_calls.append(kwargs)
            if cli_error is not None:
                raise cli_error
            return (candidate(),) if candidates is None else candidates

        def list_active_bindings(**kwargs):
            self.binding_calls.append(kwargs)
            return (binding(),) if bindings is None else bindings

        locator = ForegroundLocator(
            owner_id=OWNER, channel="wechat", account_scope="synthetic-account",
            probe=SimpleNamespace(observe_fresh=lambda **kwargs: observation),
            cli=SimpleNamespace(sessions=sessions),
            bindings=SimpleNamespace(list_active_bindings=list_active_bindings),
        )
        return locator.observe_fresh(enabled=True, deadline=time.monotonic() + 1.3 if deadline is None else deadline,
                                     check_current=check_current)

    def test_unique_confirmed_full_emoji_name_preserves_raw_preview_and_score(self):
        result = self.locate()
        self.assertEqual((result.phase, result.reason, result.binding_id, result.contact_id),
                         ("confirmed", "confirmed_active_binding_name_match", BINDING, CONTACT))
        self.assertEqual((result.recognized_name, result.recognition_confidence), ("合成學", 0.3))
        self.assertEqual(self.cli_calls[0]["keyword"], None)
        self.assertEqual((self.cli_calls[0]["type_filter"], self.cli_calls[0]["limit"]), ("all", 5000))
        self.assertLessEqual(self.cli_calls[0]["timeout_seconds"], 0.25)

    def test_duplicate_cli_username_with_another_name_does_not_prove_stable_identity(self):
        result = self.locate(candidates=(candidate(), candidate("另一个合成标题")))
        self.assertEqual(result.phase, "manual-required")
        self.assertEqual(self.binding_calls, [])

    def test_cli_trailing_whitespace_is_not_removed_before_emoji_tail_validation(self):
        for suffix in (" ", "\t", "\u3000", "\u00a0"):
            name = "合成🐯" + suffix
            with self.subTest(suffix=repr(suffix)):
                result = self.locate(candidates=(candidate(name),), bindings=(binding(name),))
                self.assertEqual(result.phase, "manual-required")
                self.assertEqual(self.binding_calls, [])

    def test_v4_without_fallback_and_v3_keep_exact_matching(self):
        for version in ("automatic-header-v3", "automatic-header-v4"):
            payload = envelope()
            payload.pop("text_fallback")
            payload["capture_version"] = version
            payload["display_name"] = "合成🐯"
            payload["quality"]["display_name_confidence"] = 0.95
            with self.subTest(version=version):
                result = self.locate(payload)
                self.assertEqual((result.phase, result.reason), ("confirmed", "confirmed_active_binding"))
                self.assertIsNone(self.cli_calls[0]["keyword"])

    def test_invalid_fallback_cannot_use_raw_exact_but_valid_fallback_checks_full_list(self):
        payload = envelope()
        payload["display_name"] = "合成&"
        payload["quality"]["display_name_confidence"] = 1.0
        for confidence in (0.89, 0.95):
            payload["text_fallback"]["confidence"] = confidence
            with self.subTest(confidence=confidence):
                result = self.locate(payload, candidates=(candidate("合成&"),), bindings=(binding("合成&"),))
                self.assertEqual(result.phase, "manual-required" if confidence < 0.9 else "confirmed")
                self.assertEqual(result.recognized_name, "合成&")
                self.assertEqual(result.recognition_confidence, 1.0)
        self.assertIsNone(self.parse(payload).qualified_evidence)

    def test_invalid_fallback_fields_are_rejected_without_echoing_text(self):
        changes = [
            {"version": "unknown"}, {"text": ""}, {"text": " "}, {"text": "合成\n候选"},
            {"text": "合成\r候选"}, {"text": "合成…"}, {"text": "合成..."}, {"text": "甲" * 257},
            {"text": 17}, {"confidence": True}, {"confidence": "0.95"},
            {"confidence": -0.1}, {"confidence": 1.01}, {"confidence": float("nan")},
            {"confidence": float("inf")}, {"text_complete": 1}, {"mask_verified": "true"},
            {"extra": "合成保密标记"},
        ]
        for change in changes:
            payload = envelope()
            payload["text_fallback"].update(change)
            with self.subTest(change=change), self.assertRaises(ProbeAdapterError) as caught:
                self.parse(payload)
            self.assertEqual(caught.exception.code, "probe_output_invalid")
            self.assertNotIn("合成保密标记", str(caught.exception))
        for missing in ("version", "text", "confidence", "text_complete", "mask_verified"):
            payload = envelope()
            payload["text_fallback"].pop(missing)
            with self.subTest(missing=missing), self.assertRaises(ProbeAdapterError):
                self.parse(payload)

    def test_overflowing_numeric_confidence_and_all_ellipsis_fail_closed(self):
        for target in ("quality", "text_fallback"):
            payload = envelope()
            key = "display_name_confidence" if target == "quality" else "confidence"
            payload[target][key] = 10 ** 1000
            with self.subTest(target=target), self.assertRaises(ProbeAdapterError):
                self.parse(payload)
        payload = envelope()
        payload["text_fallback"]["text"] = "合成⋯"
        with self.assertRaises(ProbeAdapterError):
            self.parse(payload)

    def test_v4_rejects_unknown_envelope_and_quality_fields_or_invalid_fallback_shape(self):
        for field, value in (("preview_text", "合成正文"), ("selected_row_name", "合成行")):
            payload = envelope()
            payload[field] = value
            with self.subTest(field=field), self.assertRaises(ProbeAdapterError):
                self.parse(payload)
        for value in (None, False, [], "合成"):
            payload = envelope()
            payload["text_fallback"] = value
            with self.subTest(value=value), self.assertRaises(ProbeAdapterError):
                self.parse(payload)
        payload = envelope()
        payload["quality"]["extra"] = True
        with self.assertRaises(ProbeAdapterError):
            self.parse(payload)
        payload = envelope()
        payload["capture_version"] = "automatic-header-v3"
        with self.assertRaises(ProbeAdapterError):
            self.parse(payload)

    def test_incomplete_unverified_low_or_missing_quality_cannot_confirm(self):
        for target, key, value in (
            ("quality", "layout_verified", False), ("quality", "name_complete", False),
            ("text_fallback", "text_complete", False), ("text_fallback", "mask_verified", False),
            ("text_fallback", "confidence", 0.899999),
        ):
            payload = envelope()
            payload[target][key] = value
            with self.subTest(target=target, key=key):
                result = self.locate(payload)
                self.assertEqual((result.phase, result.reason), ("manual-required", "quality_unverified"))
                self.assertEqual(self.binding_calls, [])
        for missing in ("layout_verified", "name_complete", "display_name_confidence"):
            payload = envelope()
            payload["quality"].pop(missing)
            with self.subTest(missing=missing):
                self.assertEqual(self.locate(payload).phase, "manual-required")

    def test_ninety_percent_fallback_is_allowed_without_changing_low_raw_confidence(self):
        payload = envelope()
        payload["text_fallback"]["confidence"] = 0.9
        payload["quality"]["display_name_confidence"] = 0
        result = self.locate(payload)
        self.assertEqual(result.phase, "confirmed")
        self.assertEqual(result.recognition_confidence, 0)

    def test_all_prefix_names_participate_in_ambiguity_even_unbound_or_non_emoji(self):
        for other_name in ("合成🐱", "合成", "合成A", "合成 测试", "合成🐯备注"):
            with self.subTest(other_name=other_name):
                result = self.locate(candidates=(candidate(), candidate(other_name, username="synthetic_unbound")))
                self.assertEqual((result.phase, result.reason), ("manual-required", "ambiguous_requires_selection"))
                self.assertEqual(self.binding_calls, [])

    def test_group_prefix_collision_pauses_before_binding_or_manual_matching(self):
        result = self.locate(candidates=(candidate(), candidate("合成群聊", username="synthetic_group", kind="group")))
        self.assertEqual((result.phase, result.reason), ("paused", "group_chat_suspected"))
        self.assertIsNone(result.recognized_name)
        self.assertEqual(self.binding_calls, [])

    def test_member_count_in_raw_or_fallback_pauses_and_hides_title(self):
        for target in ("raw", "fallback"):
            payload = envelope()
            if target == "raw":
                payload["display_name"] = "合成群（２）"
            else:
                payload["text_fallback"]["text"] = "合成群(2)"
            with self.subTest(target=target):
                result = self.locate(payload)
                self.assertEqual(result.phase, "paused")
                self.assertIsNone(result.recognized_name)

    def test_colored_ordinary_suffix_requires_unique_unchanged_full_binding(self):
        for name in ("合成A", "合成&", "合成-", "合成 17", "合成 🐯", "合成🐯A"):
            with self.subTest(name=name):
                result = self.locate(candidates=(candidate(name),), bindings=(binding(name),))
                self.assertEqual((result.phase, result.reason), ("confirmed", "confirmed_active_binding_name_match"))
                self.assertEqual(len(self.binding_calls), 1)

    def test_fallback_normalization_and_bounded_edits_are_independent_of_binding_rename_check(self):
        for text, name in (("合成 ", "合成🐯"), (" 合成", "合成🐯"), ("Nora", "nora🐯"),
                           ("A01", "A1🐯")):
            payload = envelope()
            payload["text_fallback"]["text"] = text
            with self.subTest(text=text, name=name):
                self.assertEqual(self.locate(payload, candidates=(candidate(name),), bindings=(binding(name),)).phase,
                                 "confirmed")
        payload["text_fallback"]["text"] = "合成测试"
        self.assertEqual(self.locate(payload, candidates=(candidate("合成測試🐯"),),
                                     bindings=(binding("合成測試🐯"),)).phase, "manual-required")

    def test_mixed_prefix_internal_space_and_multiple_simple_emoji_are_supported(self):
        payload = envelope()
        payload["text_fallback"]["text"] = "合成 Lab17"
        full = "合成 Lab17🐯🐱🌿💖"
        self.assertEqual(self.locate(payload, candidates=(candidate(full),), bindings=(binding(full),)).phase,
                         "confirmed")

    def test_missing_renamed_duplicate_or_wrong_scope_binding_does_not_confirm(self):
        wrong_owner = UUID("00000000-0000-4000-8000-000000000104")
        variants = [(), (binding("合成🐱"),), (binding(), binding()),
                    (replace(binding(), scope=ContactScope(wrong_owner, CONTACT)),),
                    (replace(binding(), account_scope="other-account"),),
                    (replace(binding(), channel="other-channel"),),
                    (replace(binding(), status=ConversationBindingStatus.REVOKED),),
                    (replace(binding(), conversation_locator="other_username"),)]
        for bindings in variants:
            with self.subTest(bindings=bindings):
                result = self.locate(bindings=bindings)
                self.assertEqual((result.phase, result.reason), ("manual-required", "unmatched_requires_selection"))
        self.assertEqual(self.binding_calls[0], {"owner_id": OWNER, "channel": "wechat",
                                               "account_scope": "synthetic-account", "bounded": True})

    def test_limit_reached_cannot_prove_unique_even_with_one_prefix_match(self):
        candidates = (candidate(),) + tuple(candidate("其他标题", f"synthetic_{index}") for index in range(4999))
        result = self.locate(candidates=candidates)
        self.assertEqual((result.phase, result.reason), ("manual-required", "session_candidates_truncated"))
        self.assertEqual(self.binding_calls, [])

    def test_cli_timeout_does_not_reuse_any_identity(self):
        result = self.locate(cli_error=TimeoutError())
        self.assertEqual((result.phase, result.reason), ("unavailable", "observation_timeout"))
        self.assertIsNone(result.binding_id)
        self.assertIsNone(result.recognized_name)

    def test_cli_receives_only_remaining_budget_and_elapsed_work_cannot_confirm(self):
        with patch("notalone.front_sync.foreground_locator.monotonic", return_value=9.9):
            result = self.locate(deadline=10)
        self.assertEqual(result.phase, "confirmed")
        self.assertAlmostEqual(self.cli_calls[0]["timeout_seconds"], 0.1)
        with patch("notalone.front_sync.foreground_locator.monotonic", side_effect=lambda: 10.1 if self.cli_calls else 8):
            result = self.locate(deadline=10)
        self.assertEqual((result.phase, result.reason), ("unavailable", "observation_timeout"))
        self.assertEqual(self.binding_calls, [])
        with patch("notalone.front_sync.foreground_locator.monotonic", side_effect=iter([8, 10, 10]).__next__):
            result = self.locate(deadline=10)
        self.assertEqual((result.phase, result.reason), ("unavailable", "observation_timeout"))
        self.assertEqual(self.cli_calls, [])

    def test_cancellation_between_probe_and_metadata_propagates(self):
        calls = 0

        def cancel():
            nonlocal calls
            calls += 1
            if calls == 3:
                raise RuntimeError("synthetic_cancelled")

        with self.assertRaisesRegex(RuntimeError, "synthetic_cancelled"):
            self.locate(check_current=cancel)
        self.assertEqual(self.cli_calls, [])

    def test_cancellation_after_metadata_or_binding_lookup_cannot_publish_identity(self):
        for stop_after in ("metadata", "binding"):
            def cancel():
                if (stop_after == "metadata" and self.cli_calls
                        or stop_after == "binding" and self.binding_calls):
                    raise RuntimeError("synthetic_cancelled")

            with self.subTest(stop_after=stop_after), self.assertRaisesRegex(RuntimeError, "synthetic_cancelled"):
                self.locate(check_current=cancel)
            self.assertEqual(len(self.cli_calls), 1)
            self.assertEqual(len(self.binding_calls), int(stop_after == "binding"))


class SupportedEmojiSuffixTest(unittest.TestCase):
    def test_only_complete_simple_default_emoji_with_optional_single_vs16(self):
        for suffix in ("🐯", "🐱🌿💖", "🐯\ufe0f", "🐯\ufe0f🐱\ufe0f"):
            with self.subTest(suffix=suffix):
                self.assertTrue(has_supported_emoji_suffix("合成" + suffix, "合成"))
        for suffix in ("", "A", "🐯A", " 🐯", "🐯 ", "🇨🇳", "🇨", "🏽", "👋🏽",
                       "👩\u200d💻", "1\ufe0f\u20e3", "©\ufe0f", "🐯\ufe0e", "🐯\ufe0f\ufe0f",
                       "🐯\U000e0067\U000e007f", "\ufe0f", "\U0010ffff"):
            with self.subTest(suffix=suffix):
                self.assertFalse(has_supported_emoji_suffix("合成" + suffix, "合成"))
        self.assertFalse(has_supported_emoji_suffix("合成🐯", "合成A"))
        self.assertFalse(has_supported_emoji_suffix("🐯", ""))


if __name__ == "__main__":
    unittest.main()
