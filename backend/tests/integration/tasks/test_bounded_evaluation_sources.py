"""正式公开合成来源的自有隔离库控制；不调模型、预算或外部CLI。"""
from __future__ import annotations

import copy
import base64
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from notalone.memory_extraction.evaluation_bounded_cases import BOUNDED_RUNTIME_INPUTS
from notalone.memory_extraction.evaluation_reference import bounded_window_projection
from notalone.memory_extraction.evaluation_bounded_sources import (
    BoundedSourcesError, cleanup_bounded_sources, load_bounded_sources, prepare_bounded_sources,
)


class BoundedEvaluationSourcesTest(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError("禁止联网"))
        guard.start()
        self.addCleanup(guard.stop)
        temporary = tempfile.TemporaryDirectory(prefix="notalone-bounded-source-control-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / "sources"
        self.archive = Path(temporary.name) / "archive"
        self.directory.mkdir(mode=0o700)
        self.archive.mkdir(mode=0o700)
        self.receipt = None
        self.addCleanup(self.finish)

    def finish(self):
        if self.receipt is not None:
            cleanup_bounded_sources(self.receipt, archive_directory=self.archive)
            self.receipt = None

    def test_fifteen_formal_sources_load_as_exact_single_windows_and_delete_cleanly(self):
        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        self.assertEqual(len(sources.windows), 15)
        self.assertEqual(len(set(sources.task_ids)), 15)
        self.assertEqual({window.owner_id for window in sources.windows}, {sources.owner_id})
        self.assertEqual(len({window.contact_id for window in sources.windows}), 15)
        self.assertEqual([item["case_id"] for item in self.receipt["cases"] if item["source_route"] == "jsonl"],
                         ["P03", "N01", "N07"])
        for window, expected in zip(sources.windows, BOUNDED_RUNTIME_INPUTS, strict=True):
            self.assertEqual(bounded_window_projection(window), {
                "messages": list(expected["messages"]), "target_indices": list(expected["target_indices"]),
            })
            for message in window.messages:
                self.assertTrue(message.source_snapshots)
                self.assertTrue(all(source["processing_status"] == "recorded" for source in message.source_snapshots))
        close = cleanup_bounded_sources(self.receipt, archive_directory=self.archive)
        self.assertEqual(close["status"], "closed")
        self.assertEqual(close["database_residual"], 0)
        self.assertTrue(all(count == 0 for count in close["residual_counts"].values()))
        self.assertEqual(len(json.loads(Path(close["archive_path"]).read_bytes())["snapshot"]["cases"]), 15)
        self.receipt = None

    def test_receipt_type_change_is_not_equivalent_to_original_numeric_version(self):
        self.receipt = prepare_bounded_sources(self.directory)
        changed = copy.deepcopy(self.receipt)
        changed["format_version"] = True
        with self.assertRaises(BoundedSourcesError):
            load_bounded_sources(changed)

    def test_lifecycle_missing_actual_representative_is_unrun_after_independent_archive(self):
        from notalone.memory_extraction.evaluation_bounded_sources import verify_bounded_lifecycle

        self.receipt = prepare_bounded_sources(self.directory)
        result = verify_bounded_lifecycle(self.receipt, archive_directory=self.archive)
        self.assertEqual(result["status"], "unrun")
        self.assertEqual(result["reason_code"], "representative_not_unique")
        self.assertEqual(result["checks"], [])
        self.assertTrue(Path(result["before_archive"]["path"]).is_file())

    def actual_sdk_representatives(self, *, omit_owner_proof=False, extra_pending=False):
        import httpx
        from langchain_deepseek import ChatDeepSeek
        from pydantic import SecretStr
        from notalone.memory_extraction.evaluation_bounded_cases import BOUNDED_RUNTIME_CASES
        from notalone.memory_extraction.evaluation_formal_task import evaluate_task
        from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime
        from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
        from notalone.memory_trace.transport import _request_hook, _response_hook
        from tests.integration.tasks.test_bounded_runtime_acceptance import direct_proposal, label

        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        selected = 0
        requests = []

        def respond(request):
            body = json.loads(request.content)
            tool = body["tools"][0]["function"]["name"]
            requests.append((selected, tool))
            texts = [message.text for message in sources.windows[selected].messages]
            if tool == "GroundedMemoryLabels":
                if selected == 0:
                    labels = {"0:0": label("event")}
                elif selected == 1:
                    labels = {"0:0": label("state" if extra_pending else "not_memory"),
                              "1:0": label("relationship_event", dependency="0:0")}
                else:
                    labels = {"0:0": label("relationship_event", "self", dependency="0:1"), "0:1": label("not_memory", "self")}
                payload = {"units": {key: {field: value for field, value in row.items() if field != "event"}
                    for key, row in labels.items()}}
            else:
                self.assertEqual(tool, "SourceVerificationOutput")
                actual = json.loads(body["messages"][1]["content"])
                if selected == 0:
                    proof = direct_proposal("BR_AUTHOR_ARRIVAL_V1", "direct_quote", texts[0])(actual)
                elif selected == 1:
                    proof = direct_proposal("BR_KIN_LEND_V1", "completed_cross", texts[1], main_index=1, identity=(0, texts[0]))(
                        {**actual, "candidates": [actual["candidates"][-1]]})
                else:
                    main, declaration = texts[0].split("。", 1)
                    proof = None if omit_owner_proof else direct_proposal("BR_REQUEST_V1", "received_inline", main + "。",
                        main_index=0, identity=(0, declaration), request=True)(actual)
                payload = {"results": [{"candidate_index": index, "verdict": "supported", "issues": [],
                    "evidence": [{"message_id": message["message_id"], "quote": message["text"]} for message in actual["messages"]
                                 if message["message_id"] in actual["candidates"][index]["source_message_ids"]],
                    "proof": proof if index == len(actual["candidates"]) - 1 else None}
                    for index in range(len(actual["candidates"]))]}
            return httpx.Response(200, request=request, json={
                "id": "synthetic-lifecycle", "object": "chat.completion", "created": 1, "model": "deepseek-flash",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": "",
                    "tool_calls": [{"id": "synthetic-tool", "type": "function", "function": {
                        "name": tool, "arguments": json.dumps(payload, ensure_ascii=False)}}]}}],
            })

        with httpx.Client(transport=httpx.MockTransport(respond), event_hooks={"request": [_request_hook], "response": [_response_hook]}) as client:
            def model(thinking):
                return ChatDeepSeek(api_key=SecretStr("synthetic-only"), model="deepseek-flash", base_url="https://api.deepseek.com",
                    max_retries=0, http_client=client, extra_body={"thinking": {"type": thinking}})

            extraction = GroundedV2ExtractionRuntime(model=model("enabled"))
            verification = LangChainSourceVerificationRuntime(model=model("disabled"), verification_mode="nullable-proof-v3")
            for selected in (0, 5, 1):
                actual = evaluate_task(BOUNDED_RUNTIME_CASES[selected], sources.windows[selected], extraction,
                    database_url=sources.database_url, task_id=sources.task_ids[selected], verification_runtime=verification)
                self.assertIsNone(actual.result.failure_reason)
        self.assertEqual(requests, [(position, tool) for position in (0, 5, 1)
                                   for tool in ("GroundedMemoryLabels", "SourceVerificationOutput")])
        return sources

    def test_actual_sdk_outputs_confirm_correct_reject_and_rebind_without_new_model_call(self):
        from notalone.memory_extraction.evaluation_bounded_sources import verify_bounded_lifecycle

        self.actual_sdk_representatives()
        result = verify_bounded_lifecycle(self.receipt, archive_directory=self.archive)
        self.assertEqual(result["status"], "passed", result)
        self.assertEqual([item["case_id"] for item in result["representatives"]], ["P01", "P06", "P02"])
        self.assertEqual(len(result["checks"]), 8)
        before = json.loads(Path(result["before_archive"]["path"]).read_bytes())["snapshot"]
        for position in (0, 5, 1):
            candidate, = before["cases"][position]["memory_api"]["body"]["candidates"]
            self.assertEqual(candidate["status"], "pending")
            self.assertEqual(candidate["dimension_evidence"]["semantic_basis"]["version"], 3)
            self.assertTrue(candidate["dimension_evidence_source_current"])
        revision_checks = [check for check in result["checks"] if "revision" in check["operation"]]
        self.assertEqual(len(revision_checks), 2)
        for check in revision_checks:
            self.assertEqual(check["api"]["memory"]["source_dependency_mode"], "all")
            self.assertEqual(check["proof_credit"], "none_manual_revision")
        self.assertFalse(result["quality_certified"])

    def test_missing_actual_owner_basis_does_not_get_lifecycle_credit_or_manual_mutation(self):
        from notalone.memory_extraction.evaluation_bounded_sources import verify_bounded_lifecycle

        self.actual_sdk_representatives(omit_owner_proof=True)
        result = verify_bounded_lifecycle(self.receipt, archive_directory=self.archive)
        self.assertEqual(result["status"], "unrun")
        self.assertEqual(result["reason_code"], "representative_evidence_missing")
        self.assertEqual(result["checks"], [])

    def test_actual_extra_candidate_keeps_body_and_all_but_correction_guard_withdraws_old_window(self):
        from notalone.memory_extraction.evaluation_bounded_sources import verify_bounded_lifecycle
        from notalone.memory_extraction.evaluation_records import canonical_sha256
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.scopes import ContactScope

        sources = self.actual_sdk_representatives(extra_pending=True)
        scope = ContactScope(sources.owner_id, sources.windows[1].contact_id)
        store = PostgresMemoryStore(sources.database_url)
        pending = store.list_pending_candidates(scope)
        self.assertEqual(len(pending), 2)
        extra, = [candidate for candidate in pending if candidate.dimension_evidence.semantic_basis is None]
        result = verify_bounded_lifecycle(self.receipt, archive_directory=self.archive)
        self.assertEqual(result["status"], "passed", result)
        from dataclasses import replace
        from notalone.memory import MemoryCandidateStatus
        self.assertEqual(store.list_pending_candidates(scope), ())
        kept = store.get_candidate(scope=scope, candidate_id=extra.candidate_id)
        self.assertIs(kept.status, MemoryCandidateStatus.INVALIDATED)
        self.assertEqual(kept.failure_reason, 'correction:old_evidence')
        self.assertEqual(canonical_sha256(replace(kept, status=extra.status,
            failure_reason=extra.failure_reason, correction_review=extra.correction_review)), canonical_sha256(extra))
        self.assertEqual(result['preserved_other_pending']['P02'], 0)
        self.assertEqual(result['guarded_other_candidates']['P02'], 1)

    def test_changed_actual_source_fails_lifecycle_rebind_before_manual_mutation(self):
        from notalone.memory_extraction.evaluation_bounded_sources import verify_bounded_lifecycle

        sources = self.actual_sdk_representatives()
        reference = sources.windows[0].messages[0].source_snapshots[0]["source_ref_id"]
        with psycopg.connect(sources.database_url) as connection:
            connection.execute("UPDATE public.message_source_ref SET source_locator=source_locator||'-changed' WHERE id=%s", (reference,))
        result = verify_bounded_lifecycle(self.receipt, archive_directory=self.archive)
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["reason_code"], "representative_source_rebind_failed")
        self.assertEqual(result["checks"], [])

    def test_changed_actual_source_locator_is_rejected_without_reconstructing_saved_window(self):
        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        reference = sources.windows[0].messages[0].source_snapshots[0]["source_ref_id"]
        with psycopg.connect(sources.database_url) as connection:
            connection.execute("UPDATE public.message_source_ref SET source_locator=source_locator||'-changed' WHERE id=%s", (reference,))
        with self.assertRaises((BoundedSourcesError, ValueError)):
            load_bounded_sources(self.receipt)

    def test_changed_actual_task_config_is_rejected(self):
        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        original = self.receipt["cases"][0]["runtime_config"]
        try:
            with psycopg.connect(sources.database_url) as connection:
                connection.execute("UPDATE public.background_task SET extraction_runtime_config=%s WHERE id=%s",
                    (Jsonb({"version": 1, "mode": "legacy", "rule_set_sha256": None}), sources.task_ids[0]))
            with self.assertRaises(BoundedSourcesError):
                load_bounded_sources(self.receipt)
        finally:
            with psycopg.connect(sources.database_url) as connection:
                connection.execute("UPDATE public.background_task SET extraction_runtime_config=%s WHERE id=%s",
                                   (Jsonb(original), sources.task_ids[0]))

    def test_changed_receipt_ownership_rejects_cleanup_and_keeps_original_database(self):
        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        changed = copy.deepcopy(self.receipt)
        changed["database"]["nonce"] = "0" * 32
        with self.assertRaises(BoundedSourcesError):
            cleanup_bounded_sources(changed, archive_directory=self.archive)
        with psycopg.connect(sources.database_url) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM public.contact").fetchone(), (15,))
        self.assertEqual(list(self.archive.iterdir()), [])

    def test_changed_database_marker_rejects_cleanup_before_any_source_is_deleted(self):
        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        name = self.receipt["database"]["name"]
        with psycopg.connect("host=/tmp dbname=postgres", autocommit=True) as admin:
            original = admin.execute("SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=%s", (name,)).fetchone()[0]
            admin.execute(sql.SQL("COMMENT ON DATABASE {} IS 'different-owner-marker'").format(sql.Identifier(name)))
            try:
                with self.assertRaises(BoundedSourcesError):
                    cleanup_bounded_sources(self.receipt, archive_directory=self.archive)
                with psycopg.connect(sources.database_url) as connection:
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.contact").fetchone(), (15,))
                    self.assertEqual(connection.execute("SELECT count(*) FROM public.source_document WHERE status='active'").fetchone(), (3,))
            finally:
                admin.execute(sql.SQL("COMMENT ON DATABASE {} IS {}").format(sql.Identifier(name), sql.Literal(original)))

    def test_receipt_permissions_are_checked_and_prepare_does_not_overwrite(self):
        self.receipt = prepare_bounded_sources(self.directory)
        path = Path(self.receipt["receipt_path"])
        before = path.read_bytes()
        os.chmod(path, 0o644)
        try:
            with self.assertRaises(BoundedSourcesError):
                load_bounded_sources(self.receipt)
        finally:
            os.chmod(path, 0o600)
        with self.assertRaises(BoundedSourcesError):
            prepare_bounded_sources(self.directory)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(load_bounded_sources(self.receipt).windows), 15)

    def test_partial_prepare_failure_preserves_existing_file_and_drops_only_created_database(self):
        collision = self.directory / "P03.jsonl"
        collision.write_text("不得覆盖的自有公开合成文件", encoding="utf-8")
        os.chmod(collision, 0o600)
        with self.assertRaises(BoundedSourcesError):
            prepare_bounded_sources(self.directory)
        self.assertEqual(collision.read_text(), "不得覆盖的自有公开合成文件")
        failed = json.loads((self.directory / "bounded-sources-prepare-failed.json").read_bytes())
        self.assertEqual(failed["status"], "dropped_residual_zero")
        self.assertIsNotNone(failed["database"])
        with psycopg.connect("host=/tmp dbname=postgres") as admin:
            self.assertEqual(admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s",
                                           (failed["database"]["name"],)).fetchone(), (0,))

    def test_cleanup_archives_redacted_trace_and_erases_all_body_records_without_positive_proof(self):
        from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory, MemoryTopic, SourceDependencyMode
        from notalone.memory.models import ConfirmedMemoryStatus, OwnerMemory
        from notalone.memory_trace.context import snapshot
        from notalone.persistence.extraction_trace import PostgresExtractionTraceStore
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
        from notalone.scopes import ContactScope

        self.receipt = prepare_bounded_sources(self.directory)
        sources = load_bounded_sources(self.receipt)
        window = sources.windows[0]
        scope = ContactScope(window.owner_id, window.contact_id)
        store = PostgresMemoryStore(sources.database_url)
        # ALL+NULL只验证正文删除依赖，不能取得任何维度或语义正证信用。
        candidate = store.create_candidate(MemoryCandidate(
            candidate_id=uuid4(), scope=scope, text="联系人原话：“我刚刚到家。”",
            category=MemoryCategory.COMMON_FACT, source_ids=(window.messages[0].message_id,),
            source_dependency_mode=SourceDependencyMode.ALL,
        ))
        confirmed = store.confirm(scope=scope, candidate_id=candidate.candidate_id, adoption_method=AdoptionMethod.MANUAL)
        self.assertIsNone(candidate.dimension_evidence)
        self.assertIs(confirmed.source_dependency_mode, SourceDependencyMode.ALL)
        own_window = sources.windows[5]
        PostgresOwnerMemoryStore(sources.database_url).create(OwnerMemory(
            memory_id=uuid4(), owner_id=sources.owner_id, text="用户原话：“" + own_window.messages[0].text + "”",
            category=MemoryCategory.RELATIONSHIP_NOTE, topic=MemoryTopic.OTHER,
            source_ids=(own_window.messages[0].message_id,), adoption_method=AdoptionMethod.MANUAL,
            status=ConfirmedMemoryStatus.ACTIVE, source_dependency_mode=SourceDependencyMode.ALL,
        ))
        traces = PostgresExtractionTraceStore(sources.database_url)
        trace_id = traces.begin(scope, run_id=uuid4(), batch_key="public-source-archive-control", payload=snapshot(window))
        body = json.dumps({"choices": [{"message": {"content": "公开合成输出", "reasoning_content": "synthetic-hidden-thinking"}}]})
        traces.append(scope, trace_id, stage="provider_response", payload={
            "body_text": body, "body_base64": base64.b64encode(body.encode()).decode(),
            "api_key": "synthetic-not-a-key",
        })
        close = cleanup_bounded_sources(self.receipt, archive_directory=self.archive)
        archive = json.loads(Path(close["archive_path"]).read_bytes())
        self.assertNotIn("synthetic-hidden-thinking", json.dumps(archive))
        self.assertNotIn("body_base64", archive["snapshot"]["cases"][0]["traces"][0]["events"][-1]["payload"])
        self.assertEqual(len(archive["original_snapshot_sha256"]), 64)
        self.assertTrue(any("body_base64" in path for path in archive["removed_paths"]))
        self.assertEqual(close["residual_counts"]["memory_candidate"], 0)
        self.assertEqual(close["residual_counts"]["confirmed_memory"], 0)
        self.assertEqual(close["residual_counts"]["owner_memory"], 0)
        self.assertEqual(close["residual_counts"]["memory_extraction_trace_event"], 0)
        self.assertEqual(close["database_residual"], 0)
        self.receipt = None


if __name__ == "__main__":
    unittest.main()
