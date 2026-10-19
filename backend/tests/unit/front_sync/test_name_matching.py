"""完整合成会话名单的名称唯一性，不涉及授权或真实联系人。"""

import unittest
from time import perf_counter

from notalone.front_sync.name_matching import SessionNameCandidate, match_session_names


def private(name: str) -> SessionNameCandidate:
    return SessionNameCandidate(name, "private")


class SessionNameMatchingTest(unittest.TestCase):
    def assert_decision(self, raw, confidence, names, kind, *, method=None, **kwargs):
        result = match_session_names(raw, confidence, tuple(private(name) for name in names), **kwargs)
        self.assertEqual(result.kind, kind, (raw, names, result))
        if method is not None:
            self.assertEqual(result.method, method)
        if kind != "unique":
            self.assertIsNone(result.candidate_index)
        return result

    def test_unique_high_confidence_exact_preserves_reliable_short_names(self):
        for name in ("Q", "合", "！"):
            with self.subTest(name=name):
                self.assert_decision(name, 0.9, (name, "其他合成"), "unique", method="exact")

    def test_high_confidence_whitespace_fold_is_legacy_exact(self):
        self.assert_decision("合成   联系人", 1, ("合成 联系人",), "unique", method="exact")

    def test_unique_nfkc_casefold_and_unicode_whitespace(self):
        self.assert_decision("ＦＯＯ\u3000\u00a0bar", 1, ("foo\tBAR",), "unique", method="normalized")

    def test_canonical_duplicates_are_ambiguous_even_when_raw_exact(self):
        result = self.assert_decision("ＡＢ", 1, ("ＡＢ", "ab"), "ambiguous")
        self.assertEqual(result.plausible_indices, (0, 1))

    def test_duplicate_rows_are_not_collapsed(self):
        result = self.assert_decision("合成甲", 1, ("合成甲", "合成甲"), "ambiguous")
        self.assertEqual(result.plausible_indices, (0, 1))

    def test_high_confidence_exact_does_not_choose_the_first_normalized_duplicate(self):
        self.assert_decision("ab", 1, ("AB", "ab"), "ambiguous")

    def test_extra_missing_and_wrong_characters_use_original_order_anchors(self):
        for raw in ("合成甲乙多", "合成乙", "合成错乙"):
            with self.subTest(raw=raw):
                result = self.assert_decision(raw, 0.5, ("合成甲乙", "遥远对象"), "unique", method="edit")
                self.assertEqual(result.candidate_index, 0)

    def test_low_quality_exact_can_match_only_when_no_close_competitor_exists(self):
        self.assert_decision("合成甲", 0.3, ("合成甲", "遥远对象"), "unique", method="edit")
        self.assert_decision("合成甲", 0.3, ("合成甲", "合成乙"), "ambiguous")

    def test_high_confidence_wrong_text_does_not_gain_an_unlimited_edit_budget(self):
        self.assert_decision("遥远对象", 1, ("合成甲乙",), "unmatched")

    def test_one_character_overlap_and_only_symbols_do_not_supply_two_anchors(self):
        for raw, name in (("合", "合成"), ("合错", "合成"), ("！", "!"), ("💛", "💚")):
            with self.subTest(raw=raw, name=name):
                self.assert_decision(raw, 0.5, (name,), "unmatched")

    def test_transposition_is_two_edits_not_an_accepted_short_name_typo(self):
        self.assert_decision("合甲成乙", 0.5, ("合成甲乙",), "unmatched")

    def test_punctuation_is_not_arbitrarily_stripped(self):
        self.assert_decision("ABCD", 0.5, ("AB!!CD",), "unmatched")

    def test_simplified_and_traditional_characters_are_not_dictionary_normalized(self):
        self.assert_decision("龙马合", 0.5, ("龍馬合",), "unmatched")

    def test_long_names_require_eighty_percent_similarity_in_addition_to_radius(self):
        self.assert_decision("ABCDEFG", 0.5, ("ABCDExy",), "unmatched")
        self.assert_decision("ABCDEFGHIJ", 0.5, ("ABCDEFGHxy",), "unique", method="edit")
        self.assert_decision("ABCDEFGHIJKLMNO", 0.5, ("ABCDEFGHIJKLxyz",), "unique", method="edit")
        self.assert_decision("ABCDEFGHIJKLMNO", 0.5, ("ABCDEFGHIJKwxyz",), "unmatched")

    def test_shortest_raw_length_uses_its_own_budget(self):
        self.assert_decision("ABCDEF", 0.5, ("ABCDEFxy",), "unmatched")

    def test_unknown_and_other_chat_types_never_supply_a_private_result(self):
        for chat_type in ("official_account", "folded", "corp_im", "bot", "unknown", ""):
            with self.subTest(chat_type=chat_type):
                result = match_session_names("合成甲", 1, (SessionNameCandidate("合成甲", chat_type),))
                self.assertEqual(result.kind, "unmatched")
                self.assertEqual(result.plausible_indices, (0,))

    def test_group_match_has_priority_over_private_and_other_competitors(self):
        result = match_session_names("合成甲", 0.5, (
            private("合成甲"), SessionNameCandidate("合成乙", "group"),
            SessionNameCandidate("合成丙", "official_account")))
        self.assertEqual(result.kind, "group")
        self.assertEqual(result.plausible_indices, (0, 1, 2))
        self.assertIsNone(result.candidate_index)

    def test_other_type_near_neighbor_is_not_filtered_before_disambiguation(self):
        result = match_session_names("合成甲", 0.5, (
            private("合成甲"), SessionNameCandidate("合成乙", "official_account")))
        self.assertEqual(result.kind, "ambiguous")
        self.assertEqual(result.plausible_indices, (0, 1))

    def test_empty_and_whitespace_metadata_names_are_skipped_not_global_failures(self):
        result = self.assert_decision("合成甲", 0.5, ("", "\u00a0", "合成甲"), "unique")
        self.assertEqual(result.candidate_index, 2)

    def test_empty_candidate_pool_is_unmatched(self):
        self.assert_decision("合成甲", 0.5, (), "unmatched")

    def test_every_close_competitor_blocks_even_without_enough_anchors(self):
        result = match_session_names("合成", 0.5, (private("合成甲"), private("合甲")))
        self.assertEqual(result.kind, "ambiguous")
        self.assertEqual(result.plausible_indices, (0, 1))
        self.assertIsNone(result.candidate_index)

    def test_symbol_expansion_is_not_an_equal_letter_anchor(self):
        result = match_session_names("™AB", 0.5, (private("TMAC"),))
        self.assertEqual(result.kind, "unmatched")

    def test_multiple_normalized_letters_from_one_source_letter_are_not_two_anchors(self):
        for raw, name in (("ßQ", "ssX"), ("ﬃQ", "ffiX")):
            with self.subTest(raw=raw, name=name):
                self.assert_decision(raw, 0.5, (name,), "unmatched")

    def test_compatibility_expansion_still_blocks_another_nearby_candidate(self):
        self.assert_decision("ßQ", 0.5, ("ssX", "ssY"), "ambiguous")

    def test_high_confidence_tail_keeps_low_raw_existing_recovery(self):
        result = match_session_names("合成學", 0, (private("合成🐯"),),
                                     tail_text="合成", tail_confidence=0.9)
        self.assertEqual((result.kind, result.method, result.candidate_index), ("unique", "tail", 0))

    def test_tail_is_not_limited_to_simple_emoji(self):
        for name in ("合成尾字", "合成👨‍👩‍👦", "合成👍🏽", "合成🇨🇳"):
            with self.subTest(name=name):
                self.assert_decision("合成错", 0, (name,), "unique", method="tail",
                                     tail_text="合成", tail_confidence=1)

    def test_tail_prefix_can_contain_one_ocr_extra_missing_or_wrong_character(self):
        for tail in ("合成甲乙多", "合成甲", "合成错乙"):
            with self.subTest(tail=tail):
                self.assert_decision("其他东西", 0, ("合成甲乙🐯",), "unique", method="tail",
                                     tail_text=tail, tail_confidence=1)

    def test_tail_remainder_is_limited_to_eight_normalized_codepoints(self):
        self.assert_decision("遥远对象", 0, ("合成" + "尾" * 8,), "unique",
                             tail_text="合成", tail_confidence=1)
        # 允许的前缀编辑预算也占一个码点；再多的尾部不能凭遮罩假设补齐。
        self.assert_decision("遥远对象", 0, ("合成" + "尾" * 10,), "unmatched",
                             tail_text="合成", tail_confidence=1)

    def test_tail_candidate_and_raw_exact_candidate_are_union_not_raw_shortcut(self):
        result = self.assert_decision("遥远对象", 1, ("遥远对象", "合成🐯"), "ambiguous",
                                     tail_text="合成", tail_confidence=1)
        self.assertEqual(result.plausible_indices, (0, 1))

    def test_low_raw_can_veto_but_cannot_alone_supply_tail_identity(self):
        self.assert_decision("合成甲", 0, ("合成甲",), "unmatched",
                             tail_text="遥远", tail_confidence=1)
        self.assert_decision("合成甲", 0, ("合成甲", "遥远🐯"), "ambiguous",
                             tail_text="遥远", tail_confidence=1)

    def test_insufficient_tail_anchors_do_not_qualify_a_unique_prefix(self):
        self.assert_decision("其他", 0, ("合🐯",), "unmatched",
                             tail_text="合", tail_confidence=1)

    def test_invalid_tail_is_rejected_even_when_raw_is_high_confidence_exact(self):
        for tail, confidence in (("合成", 0.89), ("", 1), ("\u3000", 1), (False, 1),
                                 ("合成", True), ("合成", float("nan")),
                                 ("合成", float("inf")), ("合成", None), ("合成", 1.1),
                                 ("甲" * 257, 1)):
            with self.subTest(tail=tail, confidence=confidence):
                self.assert_decision("合成甲", 1, ("合成甲",), "quality-unverified",
                                     tail_text=tail, tail_confidence=confidence)

    def test_invalid_raw_values_fail_closed(self):
        for raw, confidence in (("", 1), ("\u00a0", 1), (None, 1), (True, 1),
                                ("合成", False), ("合成", float("nan")),
                                ("合成", float("inf")), ("合成", -0.1), ("合成", 1.1),
                                ("合成", "1"), ("合成", 0.299), ("甲" * 257, 1)):
            with self.subTest(raw=raw, confidence=confidence):
                self.assert_decision(raw, confidence, ("合成",), "quality-unverified")

    def test_candidate_invalid_or_oversized_name_cannot_be_silently_dropped(self):
        for name in (None, True, "甲" * 257, "ﬃ" * 100):
            with self.subTest(name=name):
                self.assert_decision("合成甲", 1, ("合成甲", name), "quality-unverified")

    def test_normalization_expansion_has_its_own_length_limit(self):
        self.assert_decision("ﬃ" * 100, 1, ("合成甲",), "quality-unverified")
        self.assert_decision("合成甲", 1, ("合成甲",), "quality-unverified",
                             tail_text="ﬃ" * 100, tail_confidence=1)

    def test_cancellation_propagates_during_pool_normalization(self):
        calls = []

        def check_current():
            calls.append(1)
            if len(calls) == 3:
                raise TimeoutError("合成预算已耗尽")

        with self.assertRaisesRegex(TimeoutError, "合成预算已耗尽"):
            match_session_names("合成甲", 0.5, tuple(private(f"对象{i}") for i in range(1000)),
                                check_current=check_current)
        self.assertEqual(len(calls), 3)

    def test_cancellation_propagates_during_edit_comparison(self):
        calls = []

        def check_current():
            calls.append(1)
            if len(calls) == 3:
                raise RuntimeError("合成观察已取消")

        with self.assertRaisesRegex(RuntimeError, "合成观察已取消"):
            match_session_names("合成甲", 0.5, tuple(private(f"对象{i}") for i in range(65)),
                                check_current=check_current)
        self.assertEqual(len(calls), 3)

    def test_deadline_is_checked_before_any_input_work(self):
        def check_current():
            raise TimeoutError("合成预算已耗尽")

        with self.assertRaises(TimeoutError):
            match_session_names("", 1, (), check_current=check_current)

    def test_five_thousand_long_common_prefixes_have_a_bounded_budget(self):
        names = tuple(private("A" * 250 + f"{index:04d}") for index in range(5000))
        started = perf_counter()
        result = match_session_names("A" * 250 + "0000", 0.5, names)
        self.assertEqual(result.kind, "ambiguous")
        self.assertLess(perf_counter() - started, 2)

    def test_inserted_missing_or_wrong_character_recovers_only_unique_name(self):
        for raw, name in (("合成甲乙", "合成乙"), ("合成乙", "合成甲乙"),
                          ("合成甲", "合成乙"), ("合成", "合成"), ("Nora O1", "Nora 01")):
            with self.subTest(raw=raw, name=name):
                result = match_session_names(raw, 0.5, (private(name),))
                self.assertEqual((result.kind, result.method, result.candidate_index), ("unique", "edit", 0))

    def test_two_character_name_with_only_one_equal_anchor_cannot_identify_someone(self):
        for raw, name in (("合甲", "合成"), ("A", "A"), ("A甲", "A乙"), ("🐯🐱", "🐯🐱")):
            with self.subTest(raw=raw):
                result = match_session_names(raw, 0.5, (private(name),))
                self.assertEqual(result.kind, "unmatched")
                self.assertIsNone(result.candidate_index)

    def test_high_confidence_exact_can_keep_reliable_shortcut(self):
        result = match_session_names("合成甲", 0.95, (private("合成甲"), private("合成乙")))
        self.assertEqual((result.kind, result.method, result.plausible_indices), ("unique", "exact", (0,)))
        self.assertEqual(match_session_names("A", 0.95, (private("A"),)).kind, "unique")

    def test_low_confidence_exact_also_considers_other_near_names(self):
        result = match_session_names("合成甲", 0.5, (private("合成甲"), private("合成乙")))
        self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))

    def test_normalization_is_only_nfkc_casefold_and_unicode_whitespace(self):
        for raw, name, method in (("合成  测试", "合成 测试", "exact"),
                                  ("ＴＥＳＴ　甲", "test甲", "normalized"),
                                  ("合成\u2003测试", "合成测试", "normalized"),
                                  ("Straße", "STRASSE", "normalized")):
            with self.subTest(raw=raw, name=name):
                result = match_session_names(raw, 0.95, (private(name),))
                self.assertEqual((result.kind, result.method), ("unique", method))
        for raw, name in (("合---成", "合成"), ("测试", "測試"), ("合成🐯🐱🌿", "合成")):
            with self.subTest(raw=raw):
                self.assertEqual(match_session_names(raw, 0.95, (private(name),)).kind, "unmatched")

    def test_nfkc_casefold_or_whitespace_collisions_are_not_resolved_by_original_spelling(self):
        for raw, names in (("Test甲", ("ＴＥＳＴ甲", "test甲")),
                           ("合成A", ("合成A", "合成a")),
                           ("合成测试", ("合成测试", "合成 测试"))):
            with self.subTest(raw=raw):
                result = match_session_names(raw, 1, tuple(private(name) for name in names))
                self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))

    def test_duplicates_remain_separate_without_binding_knowledge(self):
        result = match_session_names("合成", 0.95, (private("合成"), private("合成")))
        self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))

    def test_edit_radius_and_long_name_similarity_reject_distant_names(self):
        examples = [
            ("abcdef", "abXXef", False),
            ("abcdefgh", "abcXefgY", False),
            ("abcdefghij", "abcXefghiY", True),
            ("abcdefghijklmno", "abcXefgYijklmZp", False),
            ("abcdefghijklmno", "abcXefgYijklmZo", True),
        ]
        for raw, name, unique in examples:
            with self.subTest(raw=raw, name=name):
                self.assertEqual(match_session_names(raw, 0.5, (private(name),)).kind == "unique", unique)

    def test_group_nearby_competitor_pauses_even_if_it_lacks_anchors(self):
        result = match_session_names("合成", 0.5, (private("合成甲"), SessionNameCandidate("合甲", "group")))
        self.assertEqual((result.kind, result.plausible_indices), ("group", (0, 1)))
        exact = match_session_names("合成", 0.95, (SessionNameCandidate("合成", "group"),))
        self.assertEqual(exact.kind, "group")

    def test_unknown_type_is_never_ignored_or_confirmed(self):
        unknown = SessionNameCandidate("合成乙", "unknown")
        result = match_session_names("合成甲", 0.5, (private("合成甲"), unknown))
        self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))
        self.assertEqual(match_session_names("合成乙", 0.95, (unknown,)).kind, "unmatched")

    def test_blank_names_do_not_match_text(self):
        result = match_session_names("合成", 0.5, (private(""), private("\u3000\t"), private("合成")))
        self.assertEqual((result.kind, result.candidate_index, result.plausible_indices), ("unique", 2, (2,)))

    def test_tail_can_have_ordinary_text_or_complex_emoji_suffix_and_even_no_suffix(self):
        for name in ("合成ABC", "合成👩\u200d💻", "合成🇨🇳", "合成", "合成备注"):
            with self.subTest(name=name):
                result = match_session_names("不相关", 0.3, (private(name),),
                                             tail_text="合成", tail_confidence=0.95)
                self.assertEqual((result.kind, result.method), ("unique", "tail"))

    def test_tail_uses_near_prefixes_and_caps_remaining_normalized_codepoints(self):
        result = match_session_names("不相关", 0.3, (private("合成甲备注"),),
                                     tail_text="合成乙", tail_confidence=0.95)
        self.assertEqual(result.kind, "unique")
        result = match_session_names("不相关", 0.3, (private("合成0123456789"),),
                                     tail_text="合成", tail_confidence=0.95)
        self.assertEqual(result.kind, "unmatched")

    def test_tail_cannot_override_a_conflicting_raw_name_even_with_high_raw_confidence(self):
        for confidence in (0, 0.5, 1):
            with self.subTest(confidence=confidence):
                result = match_session_names("公开甲", confidence,
                                             (private("公开甲"), private("测试ABC")),
                                             tail_text="测试", tail_confidence=0.95)
                self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))

    def test_every_tail_prefix_candidate_counts_not_only_emoji_or_best_distance(self):
        result = match_session_names("不相关", 0.3, (private("合成甲"), private("合成乙")),
                                     tail_text="合成", tail_confidence=0.95)
        self.assertEqual((result.kind, result.plausible_indices), ("ambiguous", (0, 1)))

    def test_bad_raw_confidence_is_rejected_even_with_strong_tail(self):
        for value in (True, False, None, "0.95", -0.1, 1.01, float("nan"), float("inf"), 10 ** 1000):
            for tail in (False, True):
                with self.subTest(value=value, tail=tail):
                    kwargs = {"tail_text": "合成", "tail_confidence": 0.95} if tail else {}
                    self.assertEqual(match_session_names("合成", value, (private("合成"),), **kwargs).kind,
                                     "quality-unverified")
        self.assertEqual(match_session_names("合成", 0.299, (private("合成"),)).kind, "quality-unverified")
        self.assertEqual(match_session_names("合成", 0.3, (private("合成"),)).kind, "unique")

    def test_invalid_tail_never_falls_back_to_high_raw_exact(self):
        for text, confidence in (("合成", 0.89), ("合成", True), ("合成", float("nan")),
                                 ("合成", float("inf")), ("合成", None), ("", 1), (17, 1)):
            with self.subTest(text=text, confidence=confidence):
                result = match_session_names("合成", 1, (private("合成"),),
                                             tail_text=text, tail_confidence=confidence)
                self.assertEqual(result.kind, "quality-unverified")

    def test_oversized_raw_tail_or_candidate_fails_closed_for_entire_list(self):
        examples = [
            ("合" * 257, {}, (private("合成"),)),
            ("合成", {"tail_text": "合" * 257, "tail_confidence": 1}, (private("合成"),)),
            ("合成", {}, (private("合成"), private("合" * 257))),
            ("合成", {}, (private("合成"), private("ß" * 256))),
        ]
        for raw, kwargs, names in examples:
            with self.subTest(raw_length=len(raw), kwargs=bool(kwargs)):
                self.assertEqual(match_session_names(raw, 1, names, **kwargs).kind, "quality-unverified")
        for raw in ("", "\u3000\t", None, 17):
            with self.subTest(raw=raw):
                self.assertEqual(match_session_names(raw, 1, (private("合成"),)).kind, "quality-unverified")

    def test_cancellation_is_checked_periodically_for_large_lists(self):
        calls = 0

        def cancel():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("synthetic_cancelled")

        with self.assertRaisesRegex(RuntimeError, "synthetic_cancelled"):
            match_session_names("合成", 0.5, tuple(private(f"合成{index}") for index in range(5000)),
                                check_current=cancel)
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
