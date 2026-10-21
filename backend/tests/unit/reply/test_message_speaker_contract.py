"""从公开上下文入口到模型调用边界验证私聊作者，不以合成输出认证语义。"""

import json
import copy
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime
from notalone.reply.context import RetrievalReplyContext
from notalone.reply.errors import ReplyContextInvariantError
from notalone.reply.interface import GenerateReply, NoSkill, RewriteDraft
from notalone.reply.tools import HistoryToolAccess
from notalone.reply.prepared_context_codec import encode_context, decode_context, PreparedContextFormatError
from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
from notalone.scopes import ContactScope, VerifiedConversationScope
from tests.input_budget_support import synthetic_budget_kwargs
from tests.unit.reply.test_langchain_vertical_slice import EmptySkillPort, ToolCallingFakeModel


class MessageSpeakerContractTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.binding = uuid4()
        self.verified = VerifiedConversationScope(self.scope.owner_id, self.scope.contact_id, self.binding)
        self.message = RetrievedMessage(uuid4(), self.scope, '合成消息：先把最小流程跑通。',
            source_ids=(uuid4(),), occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc), role='owner')
        self.retrieval = InMemoryRetrieval(messages=(self.message,))
        self.context = RetrievalReplyContext(retrieval=self.retrieval, skill_library_revision=0)
        self.command = GenerateReply(uuid4(), self.scope, self.binding,
            RewriteDraft('', input_kind='workspace', workspace_action='suggest',
                         include_relationship_context=True), skill=NoSkill())

    def build(self):
        return self.context.build(command=self.command, verified_scope=self.verified)

    def capture(self, prepared):
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'name': 'ReplyRuntimeOutput', 'id': 'synthetic-speaker-output', 'args': {
                'candidates': [{'text': '合成候选。', 'basis': '合成依据。',
                    'citation_ids': [str(self.message.message_id)], 'risk_notes': []}],
                'used_skill_version_id': None}}])])
        LangChainReplyRuntime(model=model, skill_port=EmptySkillPort(self.scope, 0),
            **synthetic_budget_kwargs(model)).generate(prepared)
        return next(json.loads(m.content) for m in model.seen_calls[0] if m.type == 'human')

    def test_changing_only_author_changes_actual_model_visible_message(self):
        first = self.capture(self.build())
        self.retrieval.messages = (replace(self.message, role='contact'),)
        second = self.capture(self.build())
        message = lambda payload: next(e for e in payload['evidence'] if e['kind'] == 'message')
        self.assertEqual(message(first).get('speaker_role'), 'owner')
        self.assertEqual(message(second).get('speaker_role'), 'contact')
        self.assertEqual(message(first)['text'], message(second)['text'])

    def test_author_only_source_change_invalidates_prepared_context(self):
        prepared = self.build()
        self.context.validate_current(prepared)
        self.retrieval.messages = (replace(self.message, role='contact'),)
        with self.assertRaises(ReplyContextInvariantError):
            self.context.validate_current(prepared)

    def test_history_tool_preserves_author_when_evidence_is_retained_for_later_use(self):
        access = HistoryToolAccess(retrieval=self.retrieval, scope=self.scope,
                                   conversation_binding_id=self.binding)
        result = json.loads(access.search(query='最小流程'))
        self.assertEqual(result['messages'][0]['role'], 'owner')
        self.assertEqual(access.evidence[0].speaker_role, 'owner')

    def test_history_search_orders_selected_messages_without_guessing_unknown_times(self):
        contact = replace(self.message, message_id=uuid4(), role='contact',
                          occurred_at=self.message.occurred_at - timedelta(minutes=1))
        unknown = replace(self.message, message_id=uuid4(), role='unknown', occurred_at=None)
        self.retrieval.messages = (unknown, self.message, contact)
        access = HistoryToolAccess(retrieval=self.retrieval, scope=self.scope,
                                   conversation_binding_id=self.binding)
        result = json.loads(access.search(query='最小流程'))
        self.assertEqual([m['message_id'] for m in result['messages']],
                         [str(contact.message_id), str(self.message.message_id), str(unknown.message_id)])
        self.assertEqual([m['speaker_role'] for m in result['messages']], ['contact', 'owner', 'unknown'])
        self.assertEqual(result['message_order'], 'known_times_ascending_unknown_last_equal_unordered')

    def test_restored_context_preserves_author_and_old_authorless_preparation_requires_reprepare(self):
        prepared = replace(self.build(), history_message_ids=(self.message.message_id,))
        encoded = encode_context(prepared)
        restored = decode_context(encoded, self.command)
        visible = next(e for e in self.capture(restored)['evidence'] if e['kind'] == 'message')
        self.assertEqual(visible['speaker_role'], 'owner')
        old = copy.deepcopy(encoded)
        old['schema_revision'] = 13
        for e in old['context']['evidence']:
            e['fields'].pop('speaker_role', None)
        with self.assertRaises(PreparedContextFormatError):
            decode_context(old, self.command)
        # 即使字段完整，旧修订也不能冒充新身份合同。
        old_with_fields = {**encoded, 'schema_revision': 13}
        with self.assertRaises(PreparedContextFormatError):
            decode_context(old_with_fields, self.command)

    def test_consecutive_owner_messages_remain_owner_in_chronological_model_context(self):
        contact = replace(self.message, message_id=uuid4(), role='contact',
                          occurred_at=self.message.occurred_at - timedelta(minutes=1))
        last = replace(self.message, message_id=uuid4(),
                       occurred_at=self.message.occurred_at + timedelta(minutes=1))
        self.retrieval.messages = (last, self.message, contact)
        payload = self.capture(self.build())
        messages = [e for e in payload['evidence'] if e['kind'] == 'message']
        self.assertEqual([e['evidence_id'] for e in messages],
                         [str(contact.message_id), str(self.message.message_id), str(last.message_id)])
        self.assertEqual([e['speaker_role'] for e in messages], ['contact', 'owner', 'owner'])
        self.assertEqual(payload.get('expression_actor'), 'owner')
        self.assertEqual(payload.get('recipient_role'), 'contact')
        self.assertNotIn('target_message_id', payload)

    def test_unknown_and_system_sources_are_explicit_without_becoming_api_instructions(self):
        for role in ('unknown', 'system'):
            with self.subTest(role=role):
                self.retrieval.messages = (replace(self.message, role=role),)
                payload = self.capture(self.build())
                source = next(e for e in payload['evidence'] if e['kind'] == 'message')
                self.assertEqual(source['speaker_role'], role)
                self.assertEqual(payload.get('expression_actor'), 'owner')
