"""在真实 Context 和受控本机 HTTP 边界核验生命周期。"""

from __future__ import annotations

import tempfile
import unittest
import threading
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4
from typing import Callable

from notalone.experiments.hindsight_adapter import HindsightRetrieval
from notalone.experiments.hindsight_client import (
    HindsightHttpClient,
    HindsightFailure,
    RecallBatch,
    RecallHit,
    bank_id_for,
    document_id_for,
)
from notalone.experiments.hindsight_lifecycle import SyntheticMemoryStore, sync_memory
from notalone.experiments.hindsight_runtime import stop
from notalone.memory import AdoptionMethod, MemoryCandidate, MemoryCategory
from notalone.reply.context import RetrievalReplyContext, ReplyContextInvariantError
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.retrieval import InMemoryRetrieval, RetrievedOwnerMemory
from notalone.scopes import ContactScope, VerifiedConversationScope


class SyntheticRecall:
    """外部服务边界替身；不替代本地检索或 Context。"""

    def __init__(
        self,
        hits: tuple[RecallHit, ...],
        *,
        bank: str | None = None,
        error: Exception | None = None,
        complete: bool = True,
    ) -> None:
        self.hits, self.bank, self.error, self.complete = hits, bank, error, complete

    def recall(self, *, bank_id: str, query: str) -> RecallBatch:
        if self.error is not None:
            raise self.error
        return RecallBatch(self.bank or bank_id, self.hits, self.complete)


class AfterReadStore(SyntheticMemoryStore):
    """模拟数据库权威读取完成后紧接着提交一次状态变化。"""

    after_read: Callable[[], None] | None = None

    def list_confirmed(self, scope: ContactScope):
        result = super().list_confirmed(scope)
        callback, self.after_read = self.after_read, None
        if callback:
            callback()
        return result


class HindsightLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(uuid4(), uuid4())
        self.binding = uuid4()
        self.store = SyntheticMemoryStore()
        self.sources = (uuid4(), uuid4())
        candidate = MemoryCandidate(
            uuid4(),
            self.scope,
            "对方乳糖不耐受",
            MemoryCategory.PREFERENCE,
            self.sources,
            confidence=0.83,
        )
        self.store.create_candidate(candidate)
        self.memory = self.store.confirm(
            scope=self.scope, candidate_id=candidate.candidate_id
        )

    def add_memory(self, text: str, *, scope: ContactScope | None = None):
        scope = scope or self.scope
        candidate = MemoryCandidate(
            uuid4(), scope, text, MemoryCategory.PREFERENCE, self.sources
        )
        self.store.create_candidate(candidate)
        return self.store.confirm(scope=scope, candidate_id=candidate.candidate_id)

    def hit(self, memory=None, *, final: float = 0.9) -> RecallHit:
        memory = memory or self.memory
        return RecallHit(
            str(uuid4()),
            str(uuid4()),
            document_id_for(memory.memory_id),
            {
                "local_memory_id": str(memory.memory_id),
                "owner_id": str(memory.scope.owner_id),
                "contact_id": str(memory.scope.contact_id),
                "layer": "confirmed_memory",
                "revision": str(memory.revision),
            },
            0.9,
            final,
        )

    def build(self, client, *, owners=(), history: bool = True):
        local = InMemoryRetrieval(memory_store=self.store, owner_memories=owners)
        adapter = HindsightRetrieval(local=local, client=client, tau=0.5)
        builder = RetrievalReplyContext(retrieval=adapter, skill_library_revision=0)
        context = builder.build(
            command=GenerateReply(
                uuid4(),
                self.scope,
                self.binding,
                RewriteDraft(
                    "牛奶喝完肚子难受，晚餐能换一道吗",
                    include_relationship_context=history,
                ),
            ),
            verified_scope=VerifiedConversationScope(
                self.scope.owner_id, self.scope.contact_id, self.binding
            ),
        )
        return builder, context, adapter

    @staticmethod
    def selected(context) -> tuple[UUID, ...]:
        return tuple(
            item.evidence_id
            for item in context.evidence
            if item.kind == "confirmed_memory"
        )

    def test_explicit_bank_allowlist_rejects_other_experiment_bank(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = HindsightHttpClient(
                base_url="http://127.0.0.1:1",
                log_path=Path(directory) / "service.log",
                allowed_bank_ids=frozenset({"notalone-experiment-allowed"}),
            )
            with self.assertRaises(ValueError):
                client.request("DELETE", "/v1/default/banks/notalone-experiment-other")

    def test_source_supported_memory_is_updated_then_removed_idempotently(self) -> None:
        documents: dict[str, dict[str, object]] = {}
        bank = bank_id_for(self.scope)

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                for item in body["items"]:
                    documents[item["document_id"]] = item
                self.respond(200, {"success": True, "async": False})

            def do_DELETE(self) -> None:
                doc = self.path.rsplit("/", 1)[-1]
                existed = documents.pop(doc, None)
                self.respond(200 if existed else 404, {"success": bool(existed)})

            def respond(self, status: int, body: dict[str, object]) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, format: str, *args: object) -> None:
                pass

        with tempfile.TemporaryDirectory() as directory:
            server = HTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = HindsightHttpClient(
                    base_url=f"http://127.0.0.1:{server.server_port}",
                    log_path=Path(directory) / "service.log",
                    allowed_bank_ids=frozenset({bank}),
                )
                sync_memory(
                    client=client,
                    scope=self.scope,
                    memory_id=self.memory.memory_id,
                    memory=self.memory,
                )
                remaining = replace(
                    self.memory, source_ids=(self.sources[1],), revision=2
                )
                sync_memory(
                    client=client,
                    scope=self.scope,
                    memory_id=self.memory.memory_id,
                    memory=remaining,
                )
                document = documents[document_id_for(self.memory.memory_id)]
                self.assertEqual(document["content"], "对方乳糖不耐受")
                self.assertEqual(document["metadata"]["revision"], "2")
                self.assertEqual(
                    document["metadata"]["source_ids"], str(self.sources[1])
                )
                sync_memory(
                    client=client,
                    scope=self.scope,
                    memory_id=self.memory.memory_id,
                    memory=None,
                )
                repeated = sync_memory(
                    client=client,
                    scope=self.scope,
                    memory_id=self.memory.memory_id,
                    memory=None,
                )
                self.assertEqual(documents, {})
                self.assertEqual(repeated["http_status"], 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_foreign_mapping_and_revision_rejection_keeps_a_valid_positive(
        self,
    ) -> None:
        contact = self.add_memory(
            "对方乳糖不耐受", scope=ContactScope(self.scope.owner_id, uuid4())
        )
        owner = self.add_memory(
            "对方乳糖不耐受", scope=ContactScope(uuid4(), self.scope.contact_id)
        )
        missing = replace(self.hit(), metadata={})
        wrong_document = replace(self.hit(), document_id="memory-unknown")
        stale = replace(self.hit(), metadata={**self.hit().metadata, "revision": "2"})
        builder, context, adapter = self.build(
            SyntheticRecall(
                (
                    self.hit(),
                    self.hit(contact),
                    self.hit(owner),
                    missing,
                    wrong_document,
                    stale,
                )
            )
        )
        builder.validate_current(context)
        self.assertEqual(self.selected(context), (self.memory.memory_id,))
        self.assertEqual(adapter.last_attempt.status, "success")
        self.assertIn(
            "scope_or_layer",
            tuple(reason for _, reason in adapter.last_attempt.rejected),
        )
        self.assertIn(
            "mapping", tuple(reason for _, reason in adapter.last_attempt.rejected)
        )

    def test_wrong_bank_is_failure_and_a_healthy_retry_can_recall(self) -> None:
        _, context, adapter = self.build(
            SyntheticRecall((self.hit(),), bank="notalone-experiment-wrong")
        )
        self.assertEqual(self.selected(context), ())
        self.assertEqual(adapter.last_attempt.status, "failure")
        builder, healthy, _ = self.build(SyntheticRecall((self.hit(),)))
        builder.validate_current(healthy)
        self.assertEqual(self.selected(healthy), (self.memory.memory_id,))

    def test_equal_text_different_ids_survive_while_chunks_are_deduplicated(
        self,
    ) -> None:
        same = self.add_memory("对方乳糖不耐受")
        hit = self.hit()
        builder, context, _ = self.build(
            SyntheticRecall(
                (hit, replace(hit, unit_id="another-chunk"), self.hit(same))
            )
        )
        builder.validate_current(context)
        self.assertEqual(
            set(self.selected(context)), {self.memory.memory_id, same.memory_id}
        )
        self.assertEqual(len(self.selected(context)), 2)

    def test_deleted_invalid_and_outside_time_records_leave_a_valid_positive(
        self,
    ) -> None:
        for kind in ("deleted", "invalid", "future", "expired"):
            with self.subTest(kind=kind):
                record = self.add_memory("对方不吃乳制品：" + kind)
                if kind == "deleted":
                    self.store.delete(scope=self.scope, memory_id=record.memory_id)
                elif kind == "invalid":
                    self.store.invalidate(scope=self.scope, memory_id=record.memory_id)
                else:
                    changes = {
                        "future": {
                            "valid_at": datetime.now(timezone.utc) + timedelta(days=1)
                        },
                        "expired": {
                            "invalid_at": datetime.now(timezone.utc) - timedelta(days=1)
                        },
                    }
                    self.store.set_snapshot(replace(record, **changes[kind]))
                builder, context, _ = self.build(
                    SyntheticRecall((self.hit(), self.hit(record)))
                )
                builder.validate_current(context)
                self.assertEqual(self.selected(context), (self.memory.memory_id,))

    def test_delete_or_correct_after_selection_invalidates_context_snapshot(
        self,
    ) -> None:
        for mutation in ("delete", "correct", "source_revision", "expiry"):
            with self.subTest(mutation=mutation):
                self.setUp()
                builder, context, _ = self.build(SyntheticRecall((self.hit(),)))
                self.assertEqual(self.selected(context), (self.memory.memory_id,))
                if mutation == "delete":
                    self.store.delete(scope=self.scope, memory_id=self.memory.memory_id)
                elif mutation == "correct":
                    corrected = self.store.correct(
                        scope=self.scope,
                        memory_id=self.memory.memory_id,
                        text="对方现在可以喝牛奶",
                    )
                    self.assertNotEqual(corrected.memory_id, self.memory.memory_id)
                elif mutation == "source_revision":
                    self.store.set_snapshot(
                        replace(self.memory, source_ids=(self.sources[1],), revision=2)
                    )
                else:
                    self.store.set_snapshot(
                        replace(
                            self.memory,
                            invalid_at=datetime.now(timezone.utc)
                            - timedelta(seconds=1),
                        )
                    )
                with self.assertRaises(ReplyContextInvariantError):
                    builder.validate_current(context)

    def test_delete_or_correct_after_authority_read_invalidates_snapshot(self) -> None:
        for mutation in ("delete", "correct"):
            with self.subTest(mutation=mutation):
                self.setUp()
                self.store = AfterReadStore()
                candidate = MemoryCandidate(
                    uuid4(),
                    self.scope,
                    "对方乳糖不耐受",
                    MemoryCategory.PREFERENCE,
                    self.sources,
                )
                self.store.create_candidate(candidate)
                self.memory = self.store.confirm(
                    scope=self.scope, candidate_id=candidate.candidate_id
                )
                if mutation == "delete":
                    self.store.after_read = lambda: self.store.delete(
                        scope=self.scope, memory_id=self.memory.memory_id
                    )
                else:
                    self.store.after_read = lambda: self.store.correct(
                        scope=self.scope,
                        memory_id=self.memory.memory_id,
                        text="对方现在可以喝牛奶",
                    )
                builder, context, _ = self.build(SyntheticRecall((self.hit(),)))
                self.assertEqual(self.selected(context), (self.memory.memory_id,))
                with self.assertRaises(ReplyContextInvariantError):
                    builder.validate_current(context)

    def test_faults_stay_observable_in_context_empty_fallback(self) -> None:
        for error in (
            ConnectionError("合成服务不可用"),
            TimeoutError("合成超时"),
            HindsightFailure("分数缺失"),
        ):
            with self.subTest(error=type(error).__name__):
                builder, context, adapter = self.build(SyntheticRecall((), error=error))
                builder.validate_current(context)
                self.assertEqual(self.selected(context), ())
                self.assertEqual(adapter.last_attempt.status, "failure")
                self.assertIn(type(error).__name__, adapter.last_attempt.error)
        _, context, adapter = self.build(SyntheticRecall((self.hit(),), complete=False))
        self.assertEqual(self.selected(context), ())
        self.assertEqual(adapter.last_attempt.status, "failure")

    def test_owner_path_and_independent_budgets_remain_local(self) -> None:
        records = [self.add_memory("牛奶" + "合成" * 49) for _ in range(8)]
        owners = tuple(
            RetrievedOwnerMemory(
                memory_id=uuid4(),
                owner_id=self.scope.owner_id,
                text="牛奶喝完肚子难受，晚餐能换一道吗" + "本人" * 22,
                category="preference",
                topic="other",
                status="active",
                source_ids=self.sources,
                adoption_method="manual",
                revision=1,
            )
            for _ in range(5)
        )
        foreign = RetrievedOwnerMemory(
            memory_id=uuid4(),
            owner_id=uuid4(),
            text="牛奶偏好",
            category="preference",
            topic="other",
            status="active",
            source_ids=self.sources,
            adoption_method="manual",
            revision=1,
        )
        builder, context, adapter = self.build(
            SyntheticRecall(tuple(self.hit(m) for m in records)),
            owners=(*owners, foreign),
        )
        builder.validate_current(context)
        contacts = tuple(e for e in context.evidence if e.kind == "confirmed_memory")
        selected_owners = tuple(e for e in context.evidence if e.kind == "owner_memory")
        self.assertEqual((len(contacts), sum(len(e.text) for e in contacts)), (5, 500))
        self.assertEqual(
            (len(selected_owners), sum(len(e.text) for e in selected_owners)), (3, 180)
        )
        self.assertNotIn(
            foreign.memory_id, tuple(e.evidence_id for e in selected_owners)
        )
        authority = adapter.search_confirmed_memories(
            scope=self.scope, query=None, memory_ids=(self.memory.memory_id,)
        )
        self.assertEqual(
            tuple(m.memory_id for m in authority), (self.memory.memory_id,)
        )

    def test_unauthorized_rewrite_and_authority_requests_do_not_call_service(
        self,
    ) -> None:
        builder, context, adapter = self.build(
            SyntheticRecall((), error=AssertionError("不应查外部历史")), history=False
        )
        builder.validate_current(context)
        self.assertEqual(tuple(e.kind for e in context.evidence), ("user_draft",))
        current = adapter.search_confirmed_memories(
            scope=self.scope, query=None, memory_ids=(self.memory.memory_id,)
        )
        self.assertEqual(tuple(m.memory_id for m in current), (self.memory.memory_id,))
        self.assertEqual(adapter.last_attempt.status, "not_called")


class HindsightEmptyResponseTest(unittest.TestCase):
    def test_empty_without_same_call_completion_is_not_success(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"results": []}')

            def log_message(self, format: str, *args: object) -> None:
                pass

        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "service.log"
            log_path.write_text("[RECALL old-call] Complete: 0 facts\n")
            server = HTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = HindsightHttpClient(
                    base_url=f"http://127.0.0.1:{server.server_port}", log_path=log_path
                )
                with self.assertRaises(HindsightFailure):
                    client.recall(
                        bank_id="notalone-experiment-empty", query="合成空结果"
                    )
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_stop_refuses_pid_that_belongs_to_another_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            pidfile = runtime / "service.pid"
            pidfile.write_text(str(os.getpid()))
            with self.assertRaisesRegex(RuntimeError, "不属于本实验 API"):
                stop(runtime)
            self.assertTrue(pidfile.exists())


if __name__ == "__main__":
    unittest.main()
