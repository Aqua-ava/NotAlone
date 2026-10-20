"""通用标题匹配只在完整名单唯一且绑定范围有效时授予身份。"""

import time
import unittest
from unittest.mock import patch

from tests.unit.front_sync import test_emoji_fallback as fixtures

binding, candidate, envelope = fixtures.binding, fixtures.candidate, fixtures.envelope


class NameMatchLocatorTest(unittest.TestCase):
    parse = fixtures.EmojiFallbackTest.parse
    locate = fixtures.EmojiFallbackTest.locate

    def payload(self, text, confidence=0.5):
        value = envelope()
        value.pop("text_fallback")
        value["display_name"] = text
        value["quality"]["display_name_confidence"] = confidence
        return value

    def test_extra_missing_substituted_characters_use_complete_metadata(self):
        for raw in ("合成测测试", "合测试", "合成侧试"):
            with self.subTest(raw=raw):
                result = self.locate(self.payload(raw), candidates=(candidate("合成测试"),),
                                     bindings=(binding("合成测试"),))
                self.assertEqual((result.phase, result.reason),
                                 ("confirmed", "confirmed_active_binding_name_match"))
                self.assertEqual((result.recognized_name, result.recognition_confidence), (raw, 0.5))
                self.assertEqual(self.cli_calls[0]["keyword"], None)
                self.assertEqual(self.cli_calls[0]["limit"], 5000)

    def test_low_score_correct_full_name_can_confirm_without_score_uplift(self):
        result = self.locate(self.payload("合成", 0.3), candidates=(candidate("合成"),),
                             bindings=(binding("合成"),))
        self.assertEqual((result.phase, result.reason), ("confirmed", "confirmed_active_binding_name_match"))
        self.assertEqual(result.recognition_confidence, 0.3)

    def test_unique_exact_name_is_not_blocked_by_other_one_character_names(self):
        result = self.locate(self.payload("合甲"), candidates=(candidate("合甲"),
            candidate("合乙", "synthetic_corp", "corp_im"), candidate("合丙", "synthetic_other_a"),
            candidate("合丁", "synthetic_other_b")), bindings=(binding("合甲"),))
        self.assertEqual((result.phase, result.reason), ("confirmed", "confirmed_active_binding_name_match"))
        self.assertEqual((result.recognized_name, result.recognition_confidence), ("合甲", 0.5))

    def test_exact_unbound_or_renamed_name_never_falls_back_to_bound_near_name(self):
        result = self.locate(self.payload("合甲"), candidates=(candidate("合甲", "synthetic_unbound"),
            candidate("合乙")), bindings=(binding("合乙"),))
        self.assertEqual(result.reason, "unmatched_requires_selection")
        self.assertIsNone(result.contact_id)
        result = self.locate(self.payload("合甲"), candidates=(candidate("合甲"),
            candidate("合乙", "synthetic_other")), bindings=(binding("旧完整名称"),))
        self.assertEqual(result.reason, "unmatched_requires_selection")
        self.assertIsNone(result.contact_id)

    def test_exact_same_name_in_another_type_is_not_hidden_by_binding(self):
        result = self.locate(self.payload("合甲"), candidates=(candidate("合甲"),
            candidate("合甲", "synthetic_corp", "corp_im")), bindings=(binding("合甲"),))
        self.assertEqual(result.reason, "ambiguous_requires_selection")
        self.assertEqual(self.binding_calls, [])

    def test_short_name_one_surviving_character_cannot_confirm(self):
        result = self.locate(self.payload("合柿"), candidates=(candidate("合成"),), bindings=(binding("合成"),))
        self.assertEqual(result.phase, "manual-required")
        self.assertEqual(self.binding_calls, [])

    def test_unbound_near_name_competes_before_binding_lookup(self):
        result = self.locate(self.payload("合成侧试"),
                             candidates=(candidate("合成测试"), candidate("合成侧式", "unbound")),
                             bindings=(binding("合成测试"),))
        self.assertEqual(result.reason, "ambiguous_requires_selection")
        self.assertEqual(self.binding_calls, [])

    def test_unknown_and_official_type_cannot_be_removed_as_competitors(self):
        for kind in ("unknown", "official_account", "corp_im"):
            with self.subTest(kind=kind):
                result = self.locate(self.payload("合成侧试"), candidates=(candidate("合成测试"),
                    candidate("合成侧式", "other", kind)))
                self.assertEqual(result.phase, "manual-required")
                self.assertEqual(self.binding_calls, [])

    def test_group_edit_neighbor_pauses_and_clears_name(self):
        result = self.locate(self.payload("合成侧试"), candidates=(candidate("合成测试"),
            candidate("合成侧式", "group", "group")))
        self.assertEqual(result.phase, "paused")
        self.assertIsNone(result.recognized_name)
        self.assertEqual(self.binding_calls, [])

    def test_rename_is_not_hidden_by_unicode_or_case_normalization(self):
        for current, previous in (("合成ＡＢ", "合成AB"), ("合成AB", "合成ab")):
            with self.subTest(current=current):
                result = self.locate(self.payload(current, 0.95), candidates=(candidate(current),),
                                     bindings=(binding(previous),))
                self.assertEqual(result.reason, "unmatched_requires_selection")

    def test_canonical_collision_even_with_high_score_is_ambiguous(self):
        result = self.locate(self.payload("合成AB", 1), candidates=(candidate("合成AB"),
            candidate("合成ＡＢ", "unbound")), bindings=(binding("合成AB"),))
        self.assertEqual(result.reason, "ambiguous_requires_selection")
        self.assertEqual(self.binding_calls, [])

    def test_duplicate_username_and_unbound_unique_name_cannot_confirm(self):
        result = self.locate(self.payload("合成测试"), candidates=(candidate("合成测试"), candidate("其他名称")),
                             bindings=(binding("合成测试"),))
        self.assertEqual(result.reason, "unmatched_requires_selection")
        self.assertEqual(self.binding_calls, [])
        result = self.locate(self.payload("合成测试"), candidates=(candidate("合成测试"),), bindings=())
        self.assertEqual(result.reason, "unmatched_requires_selection")

    def test_bad_or_incomplete_quality_never_queries_bindings(self):
        for score, complete in ((0.29, True), (1, False)):
            value = self.payload("合成测试", score)
            value["quality"]["name_complete"] = complete
            result = self.locate(value, candidates=(candidate("合成测试"),), bindings=(binding("合成测试"),))
            self.assertEqual(result.reason, "quality_unverified")
            self.assertEqual(self.binding_calls, [])

    def test_tail_does_not_hide_conflicting_raw_candidate(self):
        value = envelope()
        value["display_name"] = "另一标题"
        result = self.locate(value, candidates=(candidate(), candidate("另一标题", "other")))
        self.assertEqual(result.reason, "ambiguous_requires_selection")
        self.assertEqual(self.binding_calls, [])

    def test_general_tail_can_match_ordinary_or_complex_suffix_only_with_unique_binding(self):
        for name in ("合成A", "合成👨‍👩‍👧", "合成🇨🇳", "合成"):
            with self.subTest(name=name):
                result = self.locate(candidates=(candidate(name),), bindings=(binding(name),))
                self.assertEqual((result.phase, result.reason), ("confirmed", "confirmed_active_binding_name_match"))

    def test_deadline_expiring_during_name_matching_cannot_publish_identity(self):
        def expired(*args, **kwargs):
            with patch("notalone.front_sync.foreground_locator.monotonic", return_value=float("inf")):
                kwargs["check_current"]()
            self.fail("超过预算应退出匹配")

        with patch("notalone.front_sync.foreground_locator.match_session_names", side_effect=expired):
            result = self.locate(self.payload("合成测试"), deadline=time.monotonic() + 1)
        self.assertEqual(result.reason, "observation_timeout")

    def test_number_suffix_only_allows_reliable_unchanged_full_private_name(self):
        name = "合成测试(8)"
        result = self.locate(self.payload(name, 1), candidates=(candidate(name),), bindings=(binding(name),))
        self.assertEqual(result.phase, "confirmed")
        result = self.locate(self.payload(name, 0.5), candidates=(candidate(name),), bindings=(binding(name),))
        self.assertEqual(result.phase, "paused")
        result = self.locate(self.payload(name, 1), candidates=(candidate(name),), bindings=())
        self.assertEqual(result.phase, "paused")

    def test_group_conflict_for_numbered_private_name_uses_same_unicode_normalization(self):
        for group_name in ("Team", "team", "Ｔｅａｍ", "T e a m"):
            with self.subTest(group_name=group_name):
                name = "Team(8)"
                result = self.locate(self.payload(name, 1), candidates=(candidate(name),
                    candidate(group_name, "synthetic_group", "group")), bindings=(binding(name),))
                self.assertEqual(result.phase, "paused")
                self.assertIsNone(result.contact_id)
                self.assertEqual(self.binding_calls, [])
