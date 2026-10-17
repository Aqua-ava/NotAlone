"""有限依据的受控API投影；内存端口不代签正式持久化或模型质量。"""

from dataclasses import replace
import unittest
from uuid import uuid4

from notalone.application.memory_service import MemoryService
from notalone.memory import (
    AdoptionMethod, ConfirmedMemory, ConfirmedMemoryStatus, MemoryCandidate, OwnerMemory,
    SourceDependencyMode,
)
from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory_extraction.evidence import build_dimension_evidence
from notalone.memory_extraction.verification import validate_source_verification
from notalone.scopes import ContactScope
from notalone.server.app import create_app
from notalone.server.testing import InProcessClient
from tests.integration.server.test_memory_api import FakeContactMemory, FakeOwnerMemory
from tests.unit.memory_extraction.test_bounded_runtime_proof import (
    arrival_payload, compiled_fact, window_for,
)


NAMES = {"subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported"}


class BoundedMemoryApiTest(unittest.TestCase):
    def setUp(self):
        self.window = window_for("我刚到家。")
        self.scope = ContactScope(self.window.owner_id, self.window.contact_id)
        self.contact, self.owner = FakeContactMemory(), FakeOwnerMemory()
        self.client = InProcessClient(create_app(
            database_url="postgresql:///unused_synthetic_test", owner_id=self.scope.owner_id,
            token="synthetic-test", memory_service=MemoryService(
                contact_memory=self.contact, owner_memory=self.owner,
            ),
        ))
        self.headers = {"Authorization": "Bearer synthetic-test"}

    def _candidate(self, *, proved=False, unknown=False):
        fact = replace(compiled_fact(self.window), source_dependency_mode=SourceDependencyMode.ALL)
        evidence = None
        if proved or unknown:
            result, = validate_source_verification(({
                "candidate_index": 0, "verdict": "supported", "issues": [],
                "evidence": [{"message_id": str(self.window.messages[0].message_id), "quote": self.window.messages[0].text}],
                "proof": arrival_payload(self.window, fact) if proved else None,
            },), window=self.window, facts=(fact,), mode="nullable-proof-v3")
            evidence = build_dimension_evidence(self.window, fact, result)
        return MemoryCandidate(
            candidate_id=uuid4(), scope=self.scope, text=fact.text,
            category=fact.category, topic=fact.topic, subject=fact.subject,
            source_ids=fact.source_message_ids, confidence=fact.confidence,
            risk_flags=fact.risk_flags, alternatives=fact.alternatives,
            interpretation_reason=fact.interpretation_reason,
            valid_at=fact.valid_at, invalid_at=fact.invalid_at,
            dimension_evidence=evidence, source_dependency_mode=SourceDependencyMode.ALL,
        )

    def _pending(self, candidate):
        self.contact.pending = [candidate]
        response = self.client.get(f"/api/contacts/{self.scope.contact_id}/memory-candidates", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        return response.json()["candidates"][0]

    def test_all_without_snapshot_has_seven_required_unknowns(self):
        payload = self._pending(self._candidate())
        self.assertEqual(payload["source_dependency_mode"], "all")
        self.assertEqual(set(payload["dimension_evidence_dimensions"]), NAMES)
        self.assertTrue(all(item == {"required": True, "state": "unknown", "reason": "not_proven"}
                            for item in payload["dimension_evidence_dimensions"].values()))

    def test_actual_current_basis_reports_capabilities_without_changing_release(self):
        candidate = self._candidate(proved=True)
        payload = self._pending(candidate)
        self.assertTrue(payload["dimension_evidence_source_current"])
        states = payload["dimension_evidence_dimensions"]
        self.assertEqual(set(states), NAMES)
        self.assertTrue(all(item["state"] == "valid" and item["reason"] is None for item in states.values()))
        self.assertFalse(states["media"]["required"])
        self.assertEqual(payload["status"], "pending")

    def test_current_null_basis_does_not_sign_unproved_roles_or_time(self):
        payload = self._pending(self._candidate(unknown=True))
        states = payload["dimension_evidence_dimensions"]
        for name in ("subject", "time", "paraphrase", "reference", "reported"):
            with self.subTest(name=name):
                self.assertEqual(states[name], {"required": True, "state": "unknown", "reason": "not_proven"})
        self.assertEqual(states["media"]["state"], "valid")

    def test_unbound_snapshot_is_all_stale_and_cleared_snapshot_is_unknown(self):
        candidate = self._candidate(proved=True)
        unbound = replace(candidate, dimension_evidence=DimensionEvidence.from_payload(candidate.dimension_evidence.to_payload()))
        payload = self._pending(unbound)
        self.assertFalse(payload["dimension_evidence_source_current"])
        self.assertTrue(all(item["state"] == "stale" and item["reason"] == "source_changed_or_candidate_changed"
                            for item in payload["dimension_evidence_dimensions"].values()))
        cleared = self._pending(replace(candidate, dimension_evidence=None))
        self.assertEqual(cleared["source_dependency_mode"], "all")
        self.assertTrue(all(item["required"] and item["state"] == "unknown"
                            for item in cleared["dimension_evidence_dimensions"].values()))

    def test_any_projection_stays_unchanged_and_other_levels_only_add_all(self):
        candidate = self._candidate()
        old = self._pending(replace(candidate, source_dependency_mode=SourceDependencyMode.ANY))
        self.assertNotIn("source_dependency_mode", old)
        self.assertNotIn("dimension_evidence_dimensions", old)
        for mode in (SourceDependencyMode.ALL, SourceDependencyMode.ANY):
            self.contact.memories = [ConfirmedMemory(
                memory_id=uuid4(), scope=self.scope, text=candidate.text,
                category=candidate.category, source_ids=candidate.source_ids,
                source_candidate_id=None, adoption_method=AdoptionMethod.MANUAL,
                source_dependency_mode=mode,
            )]
            self.owner.memories = [OwnerMemory(
                memory_id=uuid4(), owner_id=self.scope.owner_id, text=candidate.text,
                category=candidate.category, source_ids=candidate.source_ids,
                topic=candidate.topic, status=ConfirmedMemoryStatus.ACTIVE,
                adoption_method=AdoptionMethod.MANUAL, source_dependency_mode=mode,
            )]
            for path in (f"/api/contacts/{self.scope.contact_id}/memories", "/api/memories/owner"):
                with self.subTest(mode=mode, path=path):
                    response = self.client.get(path, headers=self.headers)
                    self.assertEqual(response.status_code, 200)
                    item = response.json()["memories"][0]
                    self.assertEqual(item.get("source_dependency_mode"), "all" if mode is SourceDependencyMode.ALL else None)
                    self.assertNotIn("dimension_evidence_dimensions", item)


if __name__ == "__main__":
    unittest.main()
