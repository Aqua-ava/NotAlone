"""A 身份提供者及 C 领取薄接线；原 owner 交易与实际 A/C 记录契约。"""

from __future__ import annotations

import copy
import os
import unittest
from dataclasses import replace
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from notalone.application.reply_service import ReplyServiceRequest
from notalone.persistence.assistant_input_lineage import select_assistant_input_dependents
from notalone.persistence.assistant_reply_identity import prepare_assistant_reply_start
from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
from notalone.persistence.locks import lock_owner_scope
from notalone.persistence.outbound_ledger import PostgresOutboundLedger
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.reply.assistant_continuation_reference import ContinuationGenerateReply
from notalone.reply.errors import ReplyIdempotencyConflictError, ReplyStoreInvariantError
from notalone.reply.interface import GenerateReply, RewriteDraft
from notalone.reply.store import canonical_reply_input
from notalone.scopes import ContactScope, VerifiedConversationScope


DATABASE_URL = os.environ.get("NOTALONE_TEST_DATABASE_URL", "")
BINDING_ID = UUID("acb5d044-6a5e-4e9f-bc2d-053b1b1fa1d0")
NORMALIZED_INPUT = (
    '{"continued_from_candidate_id":null,"draft_text":"合成身份草稿",'
    '"include_relationship_context":false,"mode":"rewrite_draft",'
    '"skill":"auto","user_instruction":"简短一点"}'
)
CONTINUATION_METADATA = {
    "version": 1, "scope": "this_assistant_session_only", "candidate_id": None,
    "version_id": None, "effective_requirements": ["简短一点"],
}
# 已知 binding 与规范输入的离线固定摘要；测试不重算生产摘要或身份序列化。
CONTINUATION_DIGEST = "b71bcc3809cadca6c94c14cc35ce681f285d04ad3fa0b4d38f85fd0efa950ec6"


class AssistantReplyIdentityContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not DATABASE_URL:
            raise unittest.SkipTest("必须显式指定本切片的隔离 PostgreSQL 测试库。")
        with psycopg.connect(DATABASE_URL) as connection:
            name = connection.execute("SELECT current_database()").fetchone()[0]
        if not name.endswith("_test"):
            raise RuntimeError("身份提供者契约只允许隔离 _test 数据库。")

    def setUp(self) -> None:
        self.owner_id, self.contact_id = uuid4(), uuid4()
        self.owned_owners = [self.owner_id]
        self.scope = ContactScope(self.owner_id, self.contact_id)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.owner (id, display_name) VALUES (%s, '合成身份用户')",
                (self.owner_id,),
            )
            connection.execute(
                "INSERT INTO public.contact (owner_id, id, display_name) "
                "VALUES (%s, %s, '合成身份联系人')", (self.owner_id, self.contact_id),
            )
        self.addCleanup(self._clean_owner)
        PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
            account_scope="synthetic-identity", conversation_locator=f"synthetic-{uuid4()}",
            binding_id=BINDING_ID,
        )
        self.verified_scope = VerifiedConversationScope(self.owner_id, self.contact_id, BINDING_ID)
        self.session_store = PostgresAssistantSessionStore(DATABASE_URL)
        self.reply_store = PostgresReplyStore(DATABASE_URL)
        self.session_id = self.session_store.default(self.scope)

    def _clean_owner(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM public.owner WHERE id=ANY(%s::uuid[])", (self.owned_owners,))

    def _reserve_started(
        self, *, scope: ContactScope | None = None, binding_id: UUID = BINDING_ID,
        session_id: UUID | None = None, request_key: UUID | None = None,
        expected_input_version_id: UUID | None = None, start_reply: bool = True,
    ) -> tuple[ReplyServiceRequest, UUID, GenerateReply, UUID | None, UUID]:
        scope = scope or self.scope
        session_id = session_id or self.session_id
        request = ReplyServiceRequest(
            idempotency_key=request_key or uuid4(),
            content=RewriteDraft(draft_text="合成身份草稿", user_instruction="简短一点"),
            expected_input_version_id=expected_input_version_id,
        )
        turn_id = self.session_store.reserve(scope, session_id, request)
        command = request.build_command(
            owner_id=scope.owner_id, contact_id=scope.contact_id, binding_id=binding_id,
        )
        if command is None:
            raise AssertionError("合成草稿必须构造有效命令。")
        self.assertEqual(canonical_reply_input(command), NORMALIZED_INPUT)
        request_id = (self.reply_store.start(command, VerifiedConversationScope(
            scope.owner_id, scope.contact_id, binding_id,
        )).request.request_id if start_reply else None)
        with psycopg.connect(DATABASE_URL) as connection:
            input_id = connection.execute(
                "SELECT input_version_id FROM public.assistant_session_turn WHERE id=%s", (turn_id,),
            ).fetchone()[0]
        return request, turn_id, command, request_id, input_id

    def _call_hook(self, command: GenerateReply, normalized_input: str = NORMALIZED_INPUT) -> None:
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            prepare_assistant_reply_start(connection, command, self.verified_scope, normalized_input)

    def _snapshot(self) -> dict[str, list[tuple]]:
        with psycopg.connect(DATABASE_URL) as connection:
            return {table: connection.execute(
                f"SELECT xmin::text,* FROM public.{table} WHERE owner_id=%s ORDER BY id",
                (self.owner_id,),
            ).fetchall() for table in (
                "assistant_session", "assistant_session_input", "assistant_session_turn", "reply_request",
            )}

    def _assert_no_outbound(self) -> None:
        ledger = PostgresOutboundLedger(DATABASE_URL)
        for owner_id in self.owned_owners:
            self.assertEqual(ledger.summarize_by_owner(owner_id).total_calls, 0)

    def _typed_identity(self, turn_id: UUID, command: GenerateReply) -> ContinuationGenerateReply:
        # 仅合成夹具注入未来 A 元数据；A turn 和 C request 均由实际仓储产生。
        with psycopg.connect(DATABASE_URL) as connection:
            payload = connection.execute(
                "SELECT input_payload FROM public.assistant_session_turn WHERE id=%s", (turn_id,),
            ).fetchone()[0]
            connection.execute(
                "UPDATE public.assistant_session_turn SET input_payload=%s,input_digest=%s WHERE id=%s",
                (Jsonb({**payload, "continuation": copy.deepcopy(CONTINUATION_METADATA)}),
                 CONTINUATION_DIGEST, turn_id),
            )
        return ContinuationGenerateReply(
            idempotency_key=command.idempotency_key, scope=command.scope,
            conversation_binding_id=command.conversation_binding_id, content=command.content,
            continued_from_candidate_id=command.continued_from_candidate_id, skill=command.skill,
            continuation=copy.deepcopy(CONTINUATION_METADATA),
        )

    def _another_scope(self, *, another_owner: bool = False) -> tuple[ContactScope, UUID, UUID]:
        owner_id = uuid4() if another_owner else self.owner_id
        contact_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            if another_owner:
                connection.execute("INSERT INTO public.owner (id,display_name) VALUES (%s,'合成其他用户')",
                                   (owner_id,))
                self.owned_owners.append(owner_id)
            connection.execute(
                "INSERT INTO public.contact (owner_id,id,display_name) VALUES (%s,%s,'合成其他联系人')",
                (owner_id, contact_id),
            )
        scope = ContactScope(owner_id, contact_id)
        binding = PostgresConversationBindingRepository(DATABASE_URL).create_binding(
            owner_id=owner_id, contact_id=contact_id, channel="wechat", account_scope="synthetic-other-identity",
            conversation_locator=f"synthetic-{uuid4()}",
        )
        return scope, binding.binding_id, self.session_store.default(scope)

    def _source(self) -> UUID:
        source_id = uuid4()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "INSERT INTO public.source_document "
                "(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) "
                "VALUES (%s,%s,%s,'wechat_jsonl','synthetic-identity.jsonl',%s,1)",
                (source_id, self.owner_id, self.contact_id, "1" * 64),
            )
        return source_id

    def _lineage(
        self, reserved: tuple[ReplyServiceRequest, UUID, GenerateReply, UUID | None, UUID],
        parent_input: UUID, **overrides: object,
    ) -> None:
        request, turn_id, _, _, _ = reserved
        with psycopg.connect(DATABASE_URL) as connection:
            payload, session_id = connection.execute(
                "SELECT input_payload,session_id FROM public.assistant_session_turn WHERE id=%s", (turn_id,),
            ).fetchone()
            # 正常边的 parent 还经过原 reserve 的真实 CURRENT CAS；反例显式伪造单字段。
            metadata = {"version": 1, "scope": "this_assistant_session_only", "submission": {
                "idempotency_key": str(request.idempotency_key),
                "expected_input_version_id": str(parent_input),
                "displayed_group": {"session_id": str(session_id)},
            }}
            metadata.update(overrides)
            connection.execute(
                "UPDATE public.assistant_session_turn SET input_payload=%s WHERE id=%s",
                (Jsonb({**payload, "continuation": metadata}), turn_id),
            )

    def _root_dependency(self, turn_id: UUID, source_id: UUID) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_turn SET dependency_ids=%s WHERE id=%s",
                               ([source_id], turn_id))

    def test_actual_reserved_input_rejects_a_different_c_normalized_input(self) -> None:
        _, _, command, _, _ = self._reserve_started()
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            with self.assertRaises(ReplyIdempotencyConflictError):
                prepare_assistant_reply_start(
                    connection, command, self.verified_scope, "synthetic-different-normalized-input",
                )

    def test_c_start_rejects_plain_downgrade_before_creating_a_request(self) -> None:
        _, turn_id, plain, _, _ = self._reserve_started(start_reply=False)
        typed = self._typed_identity(turn_id, plain)
        before = self._snapshot()
        with self.assertRaises(ReplyIdempotencyConflictError):
            self.reply_store.start(plain, self.verified_scope)
        self.assertEqual(self._snapshot(), before)
        started = self.reply_store.start(typed, self.verified_scope)
        self.assertIsNotNone(started.request.request_id)
        after = self._snapshot()
        for table in ("assistant_session", "assistant_session_input", "assistant_session_turn"):
            self.assertEqual(after[table], before[table])
        self.assertEqual(len(after["reply_request"]), 1)
        self._assert_no_outbound()

    def test_c_start_rejects_a_different_reserved_input_without_partial_writes(self) -> None:
        _, _, command, _, _ = self._reserve_started(start_reply=False)
        changed = replace(command, content=RewriteDraft(draft_text="不同的合成草稿", user_instruction="简短一点"))
        before = self._snapshot()
        with self.assertRaises(ReplyIdempotencyConflictError):
            self.reply_store.start(changed, self.verified_scope)
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_c_start_replay_keeps_typed_identity_and_successor_current(self) -> None:
        _, turn_id, plain, _, _ = self._reserve_started(start_reply=False)
        typed = self._typed_identity(turn_id, plain)
        started = self.reply_store.start(typed, self.verified_scope)
        self.session_store.record_discussion_input(
            self.scope, self.session_id,
            {"type": "purpose_exploration", "purpose_hint": "独立后继的合成讨论"},
        )
        before = self._snapshot()
        with self.assertRaises(ReplyIdempotencyConflictError):
            self.reply_store.start(plain, self.verified_scope)
        self.assertEqual(self._snapshot(), before)
        replay = self.reply_store.start(typed, self.verified_scope)
        self.assertEqual(replay.request.request_id, started.request.request_id)
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_normal_a_input_and_global_without_a_keep_their_original_path_without_writes(self) -> None:
        _, _, command, _, _ = self._reserve_started()
        before = self._snapshot()
        self.assertIsNone(self._call_hook(command))
        self.assertEqual(self._snapshot(), before)
        global_command = replace(command, idempotency_key=uuid4())
        self.reply_store.start(global_command, self.verified_scope)
        before = self._snapshot()
        self.assertIsNone(self._call_hook(global_command))
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_same_typed_identity_is_read_only_and_plain_or_changed_identity_cannot_replay_it(self) -> None:
        _, turn_id, plain, _, input_id = self._reserve_started()
        typed = self._typed_identity(turn_id, plain)
        self.session_store.record_discussion_input(
            self.scope, self.session_id,
            {"type": "purpose_exploration", "purpose_hint": "合成后续独立讨论"},
        )
        self.assertFalse(self.session_store.is_current_input(self.scope, self.session_id, input_id))
        before = self._snapshot()
        self.assertIsNone(self._call_hook(typed))
        self.assertEqual(self._snapshot(), before)
        for invalid in (plain, replace(typed, continuation={**CONTINUATION_METADATA,
                                                           "effective_requirements": ["详细一点"]})):
            with self.subTest(typed=isinstance(invalid, ContinuationGenerateReply)):
                with self.assertRaises(ReplyIdempotencyConflictError):
                    self._call_hook(invalid)
                self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_typed_input_needs_actual_non_null_metadata_in_its_same_scope_turn(self) -> None:
        _, turn_id, plain, _, _ = self._reserve_started()
        typed = self._typed_identity(turn_id, plain)
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn "
                "SET input_payload=jsonb_set(input_payload,'{continuation}','null'::jsonb) WHERE id=%s",
                (turn_id,),
            )
        for missing in (typed, replace(typed, idempotency_key=uuid4())):
            with self.subTest(actual_turn=missing.idempotency_key == typed.idempotency_key):
                with self.assertRaises(ReplyIdempotencyConflictError):
                    self._call_hook(missing)
        self._assert_no_outbound()

    def test_foreign_owner_or_contact_with_the_same_key_cannot_supply_a_turn(self) -> None:
        request_key = uuid4()
        for another_owner in (False, True):
            foreign, binding_id, session_id = self._another_scope(another_owner=another_owner)
            self._reserve_started(scope=foreign, binding_id=binding_id, session_id=session_id,
                                  request_key=request_key)
        request = ReplyServiceRequest(request_key, RewriteDraft("合成身份草稿", "简短一点"))
        command = request.build_command(owner_id=self.owner_id, contact_id=self.contact_id, binding_id=BINDING_ID)
        self.assertIsNotNone(command)
        self.reply_store.start(command, self.verified_scope)
        before = self._snapshot()
        self.assertIsNone(self._call_hook(command))
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_actual_turn_and_command_must_use_the_verified_binding(self) -> None:
        _, _, command, _, _ = self._reserve_started()
        _, different_binding, _ = self._another_scope()
        with self.assertRaises(ReplyIdempotencyConflictError):
            self._call_hook(replace(command, conversation_binding_id=different_binding))
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            with self.assertRaises(ReplyIdempotencyConflictError):
                prepare_assistant_reply_start(connection, command, VerifiedConversationScope(
                    self.owner_id, self.contact_id, different_binding,
                ), NORMALIZED_INPUT)
        self._assert_no_outbound()

    def test_redacted_actual_turn_is_rejected_without_resurrecting_its_input(self) -> None:
        _, turn_id, command, _, _ = self._reserve_started()
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute(
                "UPDATE public.assistant_session_turn SET state='redacted',input_payload=NULL,"
                "input_digest=NULL,reply_request_id=NULL,dependency_ids='{}' WHERE id=%s", (turn_id,),
            )
        before = self._snapshot()
        with self.assertRaises(ReplyStoreInvariantError):
            self._call_hook(command)
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_identity_rejection_rolls_back_the_callers_original_owner_transaction(self) -> None:
        _, _, command, _, _ = self._reserve_started()
        before = self._snapshot()
        with self.assertRaises(ReplyIdempotencyConflictError):
            with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=self.owner_id)
                connection.execute("UPDATE public.assistant_session SET updated_at='2000-01-01' WHERE id=%s",
                                   (self.session_id,))
                prepare_assistant_reply_start(connection, command, self.verified_scope, "synthetic-wrong-input")
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_selector_follows_actual_c_anchored_continuation_edges_recursively_without_body_or_writes(self) -> None:
        root = self._reserve_started()
        child = self._reserve_started(expected_input_version_id=root[4])
        self._lineage(child, root[4])
        grandchild = self._reserve_started(expected_input_version_id=child[4])
        self._lineage(grandchild, child[4])
        source_id = self._source()
        self._root_dependency(root[1], source_id)
        before = self._snapshot()
        for seeds in ({"removed_ids": {source_id}, "reply_request_ids": []},
                      {"removed_ids": set(), "reply_request_ids": [root[3]]},
                      {"removed_ids": set(), "reply_request_ids": [], "turn_ids": (root[1],),
                       "contact_id": self.contact_id}):
            with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=self.owner_id)
                selected = select_assistant_input_dependents(connection, owner_id=self.owner_id, **seeds)
            self.assertEqual(set(selected.input_version_ids), {root[4], child[4], grandchild[4]})
            self.assertEqual(set(selected.turn_ids), {root[1], child[1], grandchild[1]})
            self.assertEqual(set(selected.reply_request_ids), {root[3], child[3], grandchild[3]})
            self.assertEqual(selected.owner_id, self.owner_id)
            self.assertNotIn("合成身份草稿", repr(selected))
        self.assertEqual(self._snapshot(), before)
        self._assert_no_outbound()

    def test_selector_rejects_forged_scope_session_key_version_and_redacted_child_edges(self) -> None:
        root = self._reserve_started()
        valid = self._reserve_started(expected_input_version_id=root[4])
        self._lineage(valid, root[4])
        for another_owner in (False, True):
            foreign, binding_id, session_id = self._another_scope(another_owner=another_owner)
            invalid = self._reserve_started(scope=foreign, binding_id=binding_id, session_id=session_id)
            self._lineage(invalid, root[4])
        other_session = PostgresAssistantSessionCatalog(DATABASE_URL).new(self.scope)
        self._lineage(self._reserve_started(session_id=other_session), root[4])
        for overrides in ({"version": 2}, {"scope": "another_assistant_session"},
                          {"submission": {"idempotency_key": str(uuid4()),
                                          "expected_input_version_id": str(root[4]),
                                          "displayed_group": {"session_id": str(self.session_id)}}}):
            self._lineage(self._reserve_started(), root[4], **overrides)
        redacted = self._reserve_started()
        self._lineage(redacted, root[4])
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("UPDATE public.assistant_session_input SET state='redacted' WHERE id=%s",
                               (redacted[4],))
        source_id = self._source()
        self._root_dependency(root[1], source_id)
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            selected = select_assistant_input_dependents(
                connection, owner_id=self.owner_id, removed_ids={source_id}, reply_request_ids=[],
            )
        self.assertEqual(set(selected.input_version_ids), {root[4], valid[4]})
        self.assertEqual(set(selected.reply_request_ids), {root[3], valid[3]})
        self._assert_no_outbound()

    def test_selector_cannot_extend_a_parent_without_an_actual_c_request(self) -> None:
        root = self._reserve_started(start_reply=False)
        child = self._reserve_started(expected_input_version_id=root[4])
        self._lineage(child, root[4])
        source_id = self._source()
        self._root_dependency(root[1], source_id)
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as connection:
            lock_owner_scope(connection, owner_id=self.owner_id)
            selected = select_assistant_input_dependents(
                connection, owner_id=self.owner_id, removed_ids={source_id}, reply_request_ids=[],
            )
        self.assertEqual(selected.input_version_ids, (root[4],))
        self.assertEqual(selected.turn_ids, (root[1],))
        self.assertEqual(selected.reply_request_ids, ())
        self._assert_no_outbound()


if __name__ == "__main__":
    unittest.main()
