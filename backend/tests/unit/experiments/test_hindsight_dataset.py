"""冻结边界拒绝错范围 gold 和同版本资料改写。"""

from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from notalone.experiments.hindsight_dataset import build_dataset, freeze_dataset


class HindsightDatasetTests(unittest.TestCase):
    def test_freeze_rejects_gold_from_another_contact(self) -> None:
        dataset = build_dataset()
        query = next(q for q in dataset.queries if q.query_id == "final-coffee-direct")
        foreign = next(m for m in dataset.memories if m.role == "scope_negative")
        bad = replace(query, contact_gold=(foreign.memory_id,))
        dataset = replace(dataset, queries=(bad,))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "gold.*范围"):
                freeze_dataset(dataset, Path(directory))

    def test_frozen_gold_cannot_be_overwritten_by_same_version(self) -> None:
        dataset = build_dataset()
        with tempfile.TemporaryDirectory() as directory:
            freeze_dataset(dataset, Path(directory))
            query = dataset.queries[0]
            changed = replace(
                dataset,
                queries=(
                    replace(query, rationale="改写 gold 的说明"),
                    *dataset.queries[1:],
                ),
            )
            with self.assertRaisesRegex(ValueError, "冻结内容已变化"):
                freeze_dataset(changed, Path(directory))

    def test_primary_corpus_and_gold_fit_agreed_minimums(self) -> None:
        dataset = build_dataset()
        final = tuple(
            q for q in dataset.queries if q.split == "final" and q.group == "paraphrase"
        )
        self.assertEqual(len(final), 60)
        self.assertEqual(len({q.query_id.split("-")[1] for q in final}), 20)
        scope = final[0].scope
        self.assertGreaterEqual(
            sum(m.layer == "contact" and m.scope == scope for m in dataset.memories),
            300,
        )
        lookup = {m.memory_id: m for m in dataset.memories}
        for query in final:
            self.assertLessEqual(len(query.contact_gold), 5)
            self.assertLessEqual(
                sum(len(lookup[m].text) for m in query.contact_gold), 600
            )


if __name__ == "__main__":
    unittest.main()
