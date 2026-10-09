"""验证 pgvector 实验的运行证据不会落入凭据，且能标明实际运行代码。"""

from __future__ import annotations

import unittest

from experiments.pgvector.evaluate import _provenance
from experiments.pgvector.runtime import RuntimeEvidence, redacted_db_url


def _evidence(db_url: str) -> dict[str, object]:
    return RuntimeEvidence(
        runtime_dir="/tmp/notalone-pgvector-memory-recall",
        db_name="notalone-pgvector-memory-recall",
        db_port=18553,
        db_url=db_url,
        database_path="/tmp/notalone-pgvector-memory-recall/database",
        pg0_version="0.15.0",
        psycopg_version="2.9.11",
        psycopg_driver="psycopg2",
        vector_extension={"name": "vector", "version": "0.8.5"},
        embedding={"model_id": "BAAI/bge-small-zh-v1.5", "dimensions": 512},
        data_hash="0" * 64,
        precondition_error=None,
    ).as_dict()


class RedactedDbUrlTest(unittest.TestCase):
    def test_userinfo_is_removed(self) -> None:
        self.assertEqual(
            redacted_db_url("postgresql://postgres:postgres@127.0.0.1:18553/postgres"),
            "postgresql://127.0.0.1:18553/postgres",
        )

    def test_url_without_userinfo_is_unchanged(self) -> None:
        url = "postgresql://127.0.0.1:18553/postgres"
        self.assertEqual(redacted_db_url(url), url)

    def test_evidence_never_contains_a_password(self) -> None:
        record = _evidence("postgresql://postgres:postgres@127.0.0.1:18553/postgres")
        self.assertNotIn("postgres:postgres", str(record))
        self.assertEqual(record["db_url"], "postgresql://127.0.0.1:18553/postgres")
        self.assertEqual(record["db_port"], 18553)

    def test_evidence_url_without_credentials_is_preserved(self) -> None:
        record = _evidence("postgresql://127.0.0.1:18553/postgres")
        self.assertEqual(record["db_url"], "postgresql://127.0.0.1:18553/postgres")


class EvaluateProvenanceTest(unittest.TestCase):
    def test_provenance_records_experiment_modules_and_hashes(self) -> None:
        provenance = _provenance()
        modules = provenance["participating_module_sha256"]
        self.assertIn("experiments/pgvector/evaluate.py", modules)
        self.assertIn("backend/src/notalone/experiments/pgvector_adapter.py", modules)
        for digest in modules.values():
            self.assertEqual(len(str(digest)), 64)

    def test_provenance_reports_git_state_honestly(self) -> None:
        provenance = _provenance()
        self.assertIn("code_commit_at_run", provenance)
        self.assertIn("participating_diff_sha256", provenance)
        self.assertIsInstance(provenance["git_available"], bool)
        self.assertTrue(provenance["no_external_requests"])


if __name__ == "__main__":
    unittest.main()
