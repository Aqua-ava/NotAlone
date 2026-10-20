"""统一工作区通过公开请求和生成边界验证。"""
import json
import unittest
from uuid import uuid4

from notalone.application.reply_request import parse_reply_request, ReplyRequestInvalid


class WorkspaceRequestTests(unittest.TestCase):
    def request(self, **content):
        return parse_reply_request(json.dumps({
            'contact_id': str(uuid4()), 'idempotency_key': str(uuid4()),
            'content': {'type': 'rewrite_draft', 'input_kind': 'workspace',
                        'workspace_action': 'suggest', 'draft_text': '',
                        'include_relationship_context': True, **content},
        }).encode())[1]

    def test_suggest_accepts_no_idea_without_inventing_confirmed_direction(self):
        content = self.request(context_text='对方：最近工作很忙。').content
        self.assertEqual(content.workspace_action, 'suggest')
        self.assertEqual(content.draft_text, '')
        self.assertEqual(content.context_text, '对方：最近工作很忙。')
        self.assertIsNone(content.pasted_direction)

    def test_recent_context_and_supplement_are_not_misrepresented_as_user_idea(self):
        from notalone.reply.context import RetrievalReplyContext
        from notalone.reply.interface import GenerateReply
        from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
        from notalone.scopes import ContactScope, VerifiedConversationScope
        scope = ContactScope(uuid4(), uuid4())
        binding = uuid4()
        kept, excluded = uuid4(), uuid4()
        retrieval = InMemoryRetrieval(messages=(
            RetrievedMessage(kept, scope, '最近工作好忙。', source_ids=(uuid4(),)),
            RetrievedMessage(excluded, scope, '不适用的旧消息。', source_ids=(uuid4(),)),
            RetrievedMessage(uuid4(), ContactScope(scope.owner_id, uuid4()), '其他联系人。', source_ids=(uuid4(),)),
        ))
        content = self.request(context_text='对方：今天终于休息了。', excluded_message_ids=[str(excluded)]).content
        command = GenerateReply(uuid4(), scope, binding, content)
        prepared = RetrievalReplyContext(retrieval=retrieval, skill_library_revision=0).build(
            command=command, verified_scope=VerifiedConversationScope(scope.owner_id, scope.contact_id, binding))
        self.assertEqual([item.evidence_id for item in prepared.evidence if item.kind == 'message'], [kept])
        self.assertIsNone(prepared.direction)
        self.assertEqual(prepared.current_text, '')
        self.assertFalse(any(item.kind == 'user_draft' for item in prepared.evidence))
        self.assertTrue(any(item.kind == 'user_current_chat' and item.text == content.context_text for item in prepared.evidence))

    def test_invalid_workspace_inputs_do_not_relax_legacy_draft_contract(self):
        for values in ({'workspace_action': 'express'}, {'workspace_action': 'unknown'},
                       {'input_kind': 'draft'}, {'context_text': 3},
                       {'excluded_message_ids': ['not-a-uuid']},
                       {'context_text': '字' * 65537}):
            with self.subTest(values=list(values)), self.assertRaises(ReplyRequestInvalid):
                self.request(**values)

    def test_workspace_input_round_trips_without_losing_action_or_exclusions(self):
        from notalone.reply.interface import GenerateReply
        from notalone.reply.store import canonical_reply_input
        from notalone.scopes import ContactScope
        excluded = str(uuid4())
        content = self.request(context_text='补充的当前聊天。', excluded_message_ids=[excluded]).content
        command = GenerateReply(uuid4(), ContactScope(uuid4(), uuid4()), uuid4(), content)
        payload = json.loads(canonical_reply_input(command))
        payload['type'] = payload.pop('mode')
        restored = self.request(**payload).content
        self.assertEqual(restored, content)

    def test_excluded_message_cannot_return_through_history_tools(self):
        from notalone.reply.tools import HistoryToolAccess
        from notalone.retrieval import InMemoryRetrieval, RetrievedMessage
        from notalone.scopes import ContactScope
        scope = ContactScope(uuid4(), uuid4())
        excluded = uuid4()
        retrieval = InMemoryRetrieval(messages=(RetrievedMessage(
            excluded, scope, '不适用的聊天。', source_ids=(uuid4(),)),))
        history = HistoryToolAccess(retrieval=retrieval, scope=scope, conversation_binding_id=uuid4(),
                                    excluded_message_ids=(excluded,))
        result = json.loads(history.search(query='不适用'))
        self.assertEqual(result['status'], 'empty')
        self.assertEqual(history.evidence, ())
