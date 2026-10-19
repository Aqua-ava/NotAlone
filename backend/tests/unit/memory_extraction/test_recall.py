"""通过公开召回接口验证数值、排序及单次调用的计算预算。"""

from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import UUID

from notalone.memory_extraction import recall


def memory(identifier, text):
    return SimpleNamespace(memory_id=UUID(int=identifier), text=text)


class HybridRecallTest(unittest.TestCase):
    def setUp(self):
        self.texts = ["周末游泳", "周末游泳"]
        self.pool = [memory(3, "周末游泳"), memory(2, "周末跑步"), memory(1, "固定读书")]
        self.vectors = [(1.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 0.0), (-1.0, 0.0)]

    def test_batch_reuses_lexical_corpus_with_same_ordered_candidates(self):
        with patch.object(recall, "embed_texts", return_value=self.vectors) as embed, patch.object(
            recall, "tokenize", wraps=recall.tokenize,
        ) as tokenize:
            rows = recall.hybrid_candidates(self.texts, self.pool, top_k=3)
        self.assertEqual([[item.memory_id.int for item in row] for row in rows], [[2, 3, 1]] * 2)
        embed.assert_called_once_with([*self.texts, *(item.text for item in self.pool)])
        self.assertEqual(tokenize.call_count, 5)

    def test_batch_reuses_memory_norms_without_changing_rrf_ties(self):
        with patch.object(recall, "embed_texts", return_value=self.vectors), patch.object(
            recall, "sqrt", wraps=recall.sqrt,
        ) as sqrt:
            rows = recall.hybrid_candidates(self.texts, self.pool, top_k=3)
        self.assertEqual([[item.memory_id.int for item in row] for row in rows], [[2, 3, 1]] * 2)
        self.assertEqual(sqrt.call_count, 5)

    def test_top_k_preserves_each_ranking_slice_and_final_id_ties(self):
        expected = {0: [], 1: [2], 2: [2, 3], 3: [2, 3, 1], 8: [2, 3, 1], -1: [3]}
        with patch.object(recall, "embed_texts", return_value=self.vectors):
            for top_k, identifiers in expected.items():
                with self.subTest(top_k=top_k):
                    rows = recall.hybrid_candidates(self.texts, self.pool, top_k=top_k)
                    self.assertEqual([[item.memory_id.int for item in row] for row in rows], [identifiers] * 2)

    def test_semantic_zero_and_negative_scores_remain_candidates(self):
        pool = [memory(30, "alpha"), memory(20, "bravo"), memory(10, "charlie"), memory(40, "delta")]
        vectors = [(1.0, 0.0), (-1.0, 0.0), (0.0, 0.0), (0.0, 1.0), (1.0, 0.0)]
        with patch.object(recall, "embed_texts", return_value=vectors):
            rows = recall.hybrid_candidates(["无关"], pool)
        self.assertEqual([item.memory_id.int for item in rows[0]], [40, 10, 20, 30])
        vectors[0] = (0.0, 0.0)
        with patch.object(recall, "embed_texts", return_value=vectors):
            rows = recall.hybrid_candidates(["无关"], pool)
        self.assertEqual([item.memory_id.int for item in rows[0]], [10, 20, 30, 40])

    def test_duplicate_texts_keep_separate_ids_and_return_original_items(self):
        pool = [memory(4, "tea"), memory(2, "tea"), memory(3, "tea")]
        with patch.object(recall, "embed_texts", return_value=[(1.0,)] * 4):
            rows = recall.hybrid_candidates(["tea"], pool)
        self.assertEqual([item.memory_id.int for item in rows[0]], [2, 3, 4])
        self.assertIs(rows[0][0], pool[1])

    def test_empty_pool_skips_encoding_but_empty_queries_still_validate_it(self):
        with patch.object(recall, "embed_texts", return_value=[(1.0,)] * 3) as embed:
            self.assertEqual(recall.hybrid_candidates(self.texts, []), [[], []])
            embed.assert_not_called()
            self.assertEqual(recall.hybrid_candidates([], self.pool), [])
            embed.assert_called_once_with([item.text for item in self.pool])
        with patch.object(recall, "embed_texts", return_value=[]):
            with self.assertRaisesRegex(ValueError, "embedding输出不符合维度契约"):
                recall.hybrid_candidates([], self.pool)

    def test_invalid_embedding_fails_before_lexical_scoring(self):
        invalid = [[], [(1.0,)], [(), ()], [(1.0,), (1.0, 0.0)],
                   [(float("nan"),), (1.0,)], [(1.0,), (float("inf"),)]]
        for vectors in invalid:
            with self.subTest(vectors=vectors), patch.object(recall, "embed_texts", return_value=vectors), patch.object(
                recall, "tokenize", wraps=recall.tokenize,
            ) as tokenize:
                with self.assertRaisesRegex(ValueError, "embedding输出不符合维度契约"):
                    recall.hybrid_candidates(["tea"], self.pool[:1])
                tokenize.assert_not_called()

    def test_unavailable_embedding_propagates_without_fallback(self):
        error = recall.EmbeddingUnavailableError(recall.EMBEDDING_UNAVAILABLE)
        with patch.object(recall, "embed_texts", side_effect=error):
            with self.assertRaises(recall.EmbeddingUnavailableError) as raised:
                recall.hybrid_candidates(self.texts, self.pool)
        self.assertIs(raised.exception, error)

    def test_next_call_rebuilds_features_and_encodes_the_actual_pool(self):
        pool = [memory(1, "tea"), memory(2, "coffee")]
        with patch.object(recall, "embed_texts", return_value=[(1.0,)] * 3) as embed:
            first = recall.hybrid_candidates(["tea"], pool, top_k=2)
            pool = [memory(1, "coffee"), memory(2, "tea")]
            second = recall.hybrid_candidates(["tea"], pool, top_k=2)
        self.assertEqual([item.memory_id.int for item in first[0]], [1, 2])
        self.assertEqual([item.memory_id.int for item in second[0]], [2, 1])
        self.assertEqual([call.args[0] for call in embed.call_args_list],
                         [["tea", "tea", "coffee"], ["tea", "coffee", "tea"]])


class Bm25RecallTest(unittest.TestCase):
    def test_term_frequency_document_frequency_and_length_have_fixed_scores(self):
        corpus = ["茶 tea TEA", "tea coffee", "", "coffee coffee"]
        expected = [0.8713850269896455, 0.6099695188927519, 0.0, 0.0]
        for actual, score in zip(recall.bm25_scores("TEA", corpus), expected):
            self.assertAlmostEqual(actual, score, places=15)
        self.assertEqual(recall.bm25_scores("tea tea tea", corpus), recall.bm25_scores("tea", corpus))
        self.assertEqual(recall.bm25_scores("coffee coffee", corpus), [0.0, expected[1], 0.0, expected[0]])

    def test_chinese_bigrams_unicode_normalization_and_short_token_filter(self):
        self.assertGreater(recall.bm25_scores("周末游泳", ["周末一起游泳"])[0], 0)
        self.assertEqual(recall.bm25_scores("ＴＥＡ", ["tea"]), recall.bm25_scores("tea", ["tea"]))
        self.assertEqual(recall.bm25_scores("茶 a 🙂", ["茶 a 🙂", ""]), [0.0, 0.0])
        self.assertEqual(recall.bm25_scores("", ["tea", ""]), [0.0, 0.0])
        self.assertEqual(recall.bm25_scores("tea", []), [])

    def test_independent_calls_score_the_changed_corpus(self):
        corpus = ["tea tea", "coffee"]
        self.assertEqual(recall.bm25_scores("tea", corpus), [0.8713850269896455, 0.0])
        corpus[0] = "coffee"
        self.assertEqual(recall.bm25_scores("tea", corpus), [0.0, 0.0])
