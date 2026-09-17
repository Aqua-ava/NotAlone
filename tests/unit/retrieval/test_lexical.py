"""共享中文词法评分的行为测试。"""

from __future__ import annotations

import unittest

from notalone.retrieval.lexical import (
    BIGRAM_WEIGHT,
    MAX_QUERY_CHARS,
    RELEVANCE_THRESHOLD,
    UNIGRAM_WEIGHT,
    WORD_WEIGHT,
    LexicalScore,
    LexicalToken,
    build_query_tokens,
    score,
    score_tokens,
    tokenize,
)


class TokenizeTest(unittest.TestCase):
    def test_cjk_run_emits_unigrams_then_bigrams(self) -> None:
        self.assertEqual(
            tokenize("加班"),
            (
                LexicalToken("加", UNIGRAM_WEIGHT),
                LexicalToken("班", UNIGRAM_WEIGHT),
                LexicalToken("加班", BIGRAM_WEIGHT),
            ),
        )

    def test_single_cjk_character_has_no_bigram(self) -> None:
        self.assertEqual(
            tokenize("猫"),
            (LexicalToken("猫", UNIGRAM_WEIGHT),),
        )

    def test_punctuation_and_whitespace_split_cjk_runs(self) -> None:
        self.assertEqual(
            tokenize("好，的 吗"),
            (
                LexicalToken("好", UNIGRAM_WEIGHT),
                LexicalToken("的", UNIGRAM_WEIGHT),
                LexicalToken("吗", UNIGRAM_WEIGHT),
            ),
        )

    def test_latin_words_are_lowercased_and_split_on_punctuation(self) -> None:
        self.assertEqual(
            tokenize("Work-life Balance"),
            (
                LexicalToken("work", WORD_WEIGHT),
                LexicalToken("life", WORD_WEIGHT),
                LexicalToken("balance", WORD_WEIGHT),
            ),
        )

    def test_mixed_text_keeps_run_order(self) -> None:
        self.assertEqual(
            tokenize("加班work"),
            (
                LexicalToken("加", UNIGRAM_WEIGHT),
                LexicalToken("班", UNIGRAM_WEIGHT),
                LexicalToken("加班", BIGRAM_WEIGHT),
                LexicalToken("work", WORD_WEIGHT),
            ),
        )

    def test_fullwidth_and_case_are_normalized(self) -> None:
        self.assertEqual(
            tokenize("Ｗｏｒｋ１２３"),
            (LexicalToken("work123", WORD_WEIGHT),),
        )
        self.assertEqual(tokenize("加班WORK"), tokenize("加班work"))

    def test_digits_form_words(self) -> None:
        self.assertEqual(
            tokenize("996"),
            (LexicalToken("996", WORD_WEIGHT),),
        )
        self.assertEqual(
            tokenize("加班996"),
            (
                LexicalToken("加", UNIGRAM_WEIGHT),
                LexicalToken("班", UNIGRAM_WEIGHT),
                LexicalToken("加班", BIGRAM_WEIGHT),
                LexicalToken("996", WORD_WEIGHT),
            ),
        )

    def test_accented_latin_words_are_preserved(self) -> None:
        self.assertEqual(
            tokenize("Café"),
            (LexicalToken("café", WORD_WEIGHT),),
        )

    def test_non_bmp_cjk_is_tokenized(self) -> None:
        self.assertEqual(
            tokenize("𠀀𠀁"),
            (
                LexicalToken("𠀀", UNIGRAM_WEIGHT),
                LexicalToken("𠀁", UNIGRAM_WEIGHT),
                LexicalToken("𠀀𠀁", BIGRAM_WEIGHT),
            ),
        )

    def test_emoji_only_separates_runs(self) -> None:
        self.assertEqual(
            tokenize("猫😀狗"),
            (
                LexicalToken("猫", UNIGRAM_WEIGHT),
                LexicalToken("狗", UNIGRAM_WEIGHT),
            ),
        )

    def test_non_string_raises_type_error(self) -> None:
        with self.assertRaises(TypeError):
            tokenize(None)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            tokenize(123)  # type: ignore[arg-type]


class LexicalTokenTest(unittest.TestCase):
    def test_empty_text_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            LexicalToken("", WORD_WEIGHT)

    def test_non_positive_weight_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            LexicalToken("加班", 0.0)
        with self.assertRaises(ValueError):
            LexicalToken("加班", -1.0)


class QueryTokensTest(unittest.TestCase):
    def test_repeated_tokens_are_deduplicated(self) -> None:
        self.assertEqual(
            build_query_tokens("加班加班"),
            (
                LexicalToken("加", UNIGRAM_WEIGHT),
                LexicalToken("班", UNIGRAM_WEIGHT),
                LexicalToken("加班", BIGRAM_WEIGHT),
                LexicalToken("班加", BIGRAM_WEIGHT),
            ),
        )

    def test_query_is_truncated_to_max_chars(self) -> None:
        tokens = build_query_tokens("好" * MAX_QUERY_CHARS + "猫")

        self.assertEqual(
            tokens,
            (
                LexicalToken("好", UNIGRAM_WEIGHT),
                LexicalToken("好好", BIGRAM_WEIGHT),
            ),
        )
        self.assertNotIn("猫", tuple(token.text for token in tokens))

    def test_empty_query_has_no_tokens(self) -> None:
        self.assertEqual(build_query_tokens(""), ())
        self.assertEqual(build_query_tokens("   "), ())

    def test_non_string_raises_type_error(self) -> None:
        with self.assertRaises(TypeError):
            build_query_tokens(None)  # type: ignore[arg-type]


class ScoreTest(unittest.TestCase):
    def test_full_overlap_scores_one(self) -> None:
        result = score("加班", "他最近天天加班")

        self.assertAlmostEqual(result.score, 1.0)
        self.assertEqual(result.matched_terms, ("加", "班", "加班"))

    def test_partial_overlap_scores_matched_weight_ratio(self) -> None:
        result = score("明天开会", "开会讨论项目")

        self.assertAlmostEqual(result.score, 2.0 / 5.0)
        self.assertEqual(result.matched_terms, ("开", "会", "开会"))

    def test_no_overlap_scores_zero(self) -> None:
        result = score("旅行", "他最近加班")

        self.assertEqual(result, LexicalScore(0.0, ()))

    def test_latin_substring_does_not_match(self) -> None:
        result = score("art", "cart")

        self.assertEqual(result, LexicalScore(0.0, ()))

    def test_cjk_bigram_matches_adjacent_run(self) -> None:
        result = score("电话", "打电话给我")

        self.assertAlmostEqual(result.score, 1.0)

    def test_empty_query_scores_zero(self) -> None:
        self.assertEqual(score("", "任何内容"), LexicalScore(0.0, ()))
        self.assertEqual(score("   ", "任何内容"), LexicalScore(0.0, ()))

    def test_empty_memory_scores_zero(self) -> None:
        self.assertEqual(score("加班", ""), LexicalScore(0.0, ()))

    def test_score_tokens_matches_convenience_score(self) -> None:
        query_tokens = build_query_tokens("明天开会")

        self.assertEqual(
            score_tokens(query_tokens, "开会讨论项目"),
            score("明天开会", "开会讨论项目"),
        )

    def test_empty_query_tokens_score_zero(self) -> None:
        self.assertEqual(score_tokens((), "加班"), LexicalScore(0.0, ()))

    def test_non_string_raises_type_error(self) -> None:
        with self.assertRaises(TypeError):
            score(None, "加班")  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            score("加班", None)  # type: ignore[arg-type]


class ConstantTest(unittest.TestCase):
    def test_constants_follow_adr_028(self) -> None:
        self.assertEqual(UNIGRAM_WEIGHT, 0.5)
        self.assertEqual(BIGRAM_WEIGHT, 1.0)
        self.assertEqual(WORD_WEIGHT, 1.0)
        self.assertEqual(MAX_QUERY_CHARS, 200)
        self.assertEqual(RELEVANCE_THRESHOLD, 0.15)


if __name__ == "__main__":
    unittest.main()
