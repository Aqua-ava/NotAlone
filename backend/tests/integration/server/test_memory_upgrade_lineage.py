"""跨联系人本人资料的完整提取来源须同步撤销升级暂存副本。"""

import unittest

import psycopg

from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.memory_extraction.command import run_extraction
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
from notalone.scopes import ContactScope
from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture
from tests.integration.server.test_memory_upgrade import UpgradeHttpSupport


class MemoryUpgradeLineageHttpTest(
    UpgradeHttpSupport, CoreBusinessFlowFixture, unittest.TestCase,
):
    def test_owner_preview_original_trace_source_delete_erases_before_read_and_restart(self):
        # A 先有一条本人输入；owner 升级的有限窗口只选 A，不把 B 资料重新提取。
        _, selected = self._raw(("我平时喜欢合成红茶。",), speaker="user")
        context_source, context_ids = self._raw(
            ("合成上下文：我们在讨论本人的饮茶偏好。",),
            contact=self.second_contact_id,
        )
        claim = "本人偏好合成热茶。"
        _, claim_ids = self._raw(
            (claim,), contact=self.second_contact_id, speaker="user",
        )

        class SyntheticSelfRuntime:
            def extract(self, window):
                return ({
                    "text": claim, "category": "preference", "subject": "self",
                    "topic": "other",
                    "source_message_ids": [str(claim_ids[0])],
                    "confidence": 0.95, "risk_flags": [],
                    "valid_at": None, "invalid_at": None,
                    "speech_act": "assertion", "assertion_status": "asserted",
                    "figurative_type": "literal", "alternatives": [],
                    "interpretation_reason": "本人在合成消息中明确陈述偏好。",
                },)

        # 正式提取链写入原窗口、候选及 trace。未配置核验器且门保持关闭，
        # 只能产生待定候选；本人资料仍须通过公开入口由用户明确确认。
        scope = ContactScope(self.owner_id, self.second_contact_id)
        stats = run_extraction(
            scope=scope,
            messages=load_contact_messages(scope, self.database_url),
            watermark_message_id=None, runtime=SyntheticSelfRuntime(),
            memory_port=PostgresMemoryStore(self.database_url),
            owner_memory_port=PostgresOwnerMemoryStore(self.database_url),
            batch_size=2,
        )
        self.assertEqual((stats.pending, stats.failed_batches), (1, 0))
        candidate_path = f"/api/contacts/{self.second_contact_id}/memory-candidates"
        candidates = self._get(self.backend, candidate_path)["candidates"]
        self.assertEqual(len(candidates), 1, candidates)
        candidate = candidates[0]
        status, confirmed = self.backend.request(
            f"{candidate_path}/{candidate['candidate_id']}/confirm", {},
        )
        self.assertEqual(status, 200, confirmed)
        old = confirmed["memory"]
        self.assertEqual(old["adoption_method"], "manual")
        self.assertEqual(old["source_ids"], [str(claim_ids[0])])
        self.assertNotIn(str(context_source), old["source_ids"])

        # 证明 S 是正式原始窗口/trace 的参与来源，不是伪造 proof 或直接主张来源。
        with psycopg.connect(self.database_url) as connection:
            original = connection.execute(
                "SELECT dimension_evidence,correction_evidence "
                "FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                (self.owner_id, candidate["candidate_id"]),
            ).fetchone()
            self.assertIsNotNone(original[0])
            self.assertEqual(
                {item["message_id"] for item in original[0]["messages"]},
                {str(context_ids[0]), str(claim_ids[0])},
            )
            self.assertIn(str(context_source), original[1]["source_ids"])
            self.assertFalse(original[1].get("has_memory_context", False))
            traces = connection.execute(
                "SELECT DISTINCT dependency.trace_id "
                "FROM public.memory_extraction_trace_dependency AS dependency "
                "JOIN public.memory_extraction_trace_link AS link "
                "ON link.owner_id=dependency.owner_id AND link.trace_id=dependency.trace_id "
                "WHERE link.owner_id=%s AND link.record_kind='candidate' "
                "AND link.record_id=%s AND dependency.source_id=%s",
                (self.owner_id, candidate["candidate_id"], context_source),
            ).fetchall()
            self.assertEqual(len(traces), 1)
            original_trace = traces[0][0]
        overview = self._get(self.backend, "/api/memories/owner/overview")["overview"]
        entry = next(
            item for item in overview["entries"]
            if item["memory"]["memory_id"] == old["memory_id"]
        )
        self.assertEqual(entry["provenance"]["kind"], "source_supported")
        with psycopg.connect(self.database_url) as connection:
            dependencies = connection.execute(
                "SELECT source_ids FROM public.relationship_overview_projection "
                "WHERE owner_id=%s AND scope_kind='owner'", (self.owner_id,),
            ).fetchone()[0]
        self.assertIn(context_source, dependencies)
        self.assertNotIn("合成上下文", str(overview))

        # 独立手录资料没有历史提取证明；预览与恢复不得替它补造版本依据。
        status, manual = self.backend.request("/api/memories/manual-owner", {
            "text": "本人偏好合成纸质书。", "category": "preference",
        })
        self.assertEqual(status, 200, manual)
        manual_id = manual["memory"]["memory_id"]
        with psycopg.connect(self.database_url) as connection:
            unknown = connection.execute(
                "SELECT source_candidate_id,version_evidence "
                "FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                (self.owner_id, manual_id),
            ).fetchone()
        self.assertEqual(unknown, (None, None))

        prepared, _ = self._prepare(kind="owner", limit=1)
        job = self._wait(prepared, kind="owner")
        self.assertEqual(len(job["batches"]), 1)
        batch = job["batches"][0]
        self.assertEqual(batch["contact_id"], str(self.contact_id))
        current = {
            record["memory_id"]: record for record in batch["comparison"]["current"]
        }
        self.assertIn(old["memory_id"], current)
        self.assertEqual(current[manual_id]["proof_kind"], "unknown")
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT message_ids FROM public.memory_upgrade_batch "
                "WHERE owner_id=%s AND id=%s",
                (self.owner_id, batch["batch_id"]),
            ).fetchone()[0], selected)
            self.assertEqual(connection.execute(
                "SELECT dimension_evidence,correction_evidence "
                "FROM public.memory_candidate WHERE owner_id=%s AND id=%s",
                (self.owner_id, candidate["candidate_id"]),
            ).fetchone(), original)
        calls_before = len(self.extraction_model.seen_calls)

        self._delete_source(context_source, contact=self.second_contact_id)

        # 此处没有执行升级 GET：删除事务必须已清空所有暂存副本及完整依赖。
        self._assert_workflow_erased(job)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT status FROM public.memory_extraction_trace "
                "WHERE owner_id=%s AND trace_id=%s",
                (self.owner_id, original_trace),
            ).fetchone(), ("deleted",))
            self.assertEqual(connection.execute(
                "SELECT count(*) FROM public.memory_extraction_trace_event "
                "WHERE owner_id=%s AND trace_id=%s",
                (self.owner_id, original_trace),
            ).fetchone()[0], 0)
            self.assertEqual(connection.execute(
                "SELECT source_candidate_id,version_evidence "
                "FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                (self.owner_id, manual_id),
            ).fetchone(), unknown)

        rebuilt = self._backend(self.owner_id)
        recovered = self._get(
            rebuilt, f"/api/memory-upgrades/{job['job_id']}?scope=owner",
        )
        self.assertTrue(all(
            item["state"] == "invalidated" and item["comparison"] is None
            for item in recovered["batches"]
        ))
        (status, rejected), _ = self._action(
            job, "apply", kind="owner", backend=rebuilt,
        )
        self.assertEqual(status, 409, rejected)
        self.assertEqual(len(self.extraction_model.seen_calls), calls_before)
        self._assert_workflow_erased(job)
        with psycopg.connect(self.database_url) as connection:
            self.assertEqual(connection.execute(
                "SELECT source_candidate_id,version_evidence "
                "FROM public.owner_memory WHERE owner_id=%s AND id=%s",
                (self.owner_id, manual_id),
            ).fetchone(), unknown)
