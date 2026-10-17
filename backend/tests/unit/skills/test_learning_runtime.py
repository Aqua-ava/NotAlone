"""用合成模型验证新用途只有一次有界提案调用及无正文台账。"""

import unittest
from unittest.mock import patch
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.ledger.models import LedgerOutcome
from notalone.scopes import ContactScope
from notalone.skills.learning import LearningBatch, SkillLearningInvalid
from notalone.skills.learning_runtime import LangChainSkillProposalRuntime, SkillLearningRuntimeError
from notalone.application.skill_learning import PrioritySkillProposalRuntime
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class LearningRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.scope = ContactScope(uuid4(), uuid4())
        self.batch = LearningBatch(({"material_id": str(uuid4()), "priority": "correction", "content": {"correction": "合成私人纠正"}},), (), (), 0)
        self.ledger = InMemoryOutboundLedger()

    def test_no_new_method_single_call_and_body_free_ledger(self):
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'id': 'synthetic-proposal', 'name': 'SkillLearningProposal', 'args': {'outcome': 'no_change'},
        }])])
        result = LangChainSkillProposalRuntime(model=model, ledger=self.ledger).propose(scope=self.scope, batch=self.batch)
        self.assertEqual(result, {'outcome': 'no_change'})
        self.assertEqual(len(model.seen_calls), 1)
        entries = self.ledger.list_by_owner(self.scope.owner_id)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].contact_id, self.scope.contact_id)
        self.assertEqual(entries[0].outcome, LedgerOutcome.SUCCEEDED)
        self.assertNotIn('合成私人纠正', repr(entries))

    def test_single_large_ordinary_material_can_progress_whole_with_actual_json_budget(self):
        material={'material_id':str(uuid4()),'priority':'ordinary','content':{
            'type':'purpose_exploration','purpose_hint':'"'*4096,'requirements':'"'*4096}}
        batch=LearningBatch((material,),(),(),0)
        self.assertTrue(batch.ready,'单份合法材料占过半JSON预算时不能永久等待第二份')
        model=ToolCallingFakeModel(responses=[AIMessage(content='',tool_calls=[{
            'id':'synthetic-bounded','name':'SkillLearningProposal','args':{'outcome':'no_change'}}])])
        result=LangChainSkillProposalRuntime(model=model,ledger=self.ledger).propose(scope=self.scope,batch=batch)
        self.assertEqual(result,{'outcome':'no_change'})
        self.assertEqual(len(model.seen_calls),1)
        payload=model.seen_calls[0][1].content
        self.assertLessEqual(len(payload),24000)
        self.assertEqual(__import__('json').loads(payload)['materials'],[material])

    def test_local_tool_binding_failure_does_not_create_an_outbound_call(self):
        model = ToolCallingFakeModel(responses=[])
        with patch.object(ToolCallingFakeModel, 'bind_tools', side_effect=ValueError('合成绑定故障')):
            with self.assertRaises(SkillLearningRuntimeError):
                LangChainSkillProposalRuntime(model=model, ledger=self.ledger).propose(
                    scope=self.scope, batch=self.batch)
        self.assertEqual(model.seen_calls, [])
        self.assertEqual(len(self.ledger.list_by_owner(self.scope.owner_id)), 0)

    def test_failed_invoke_still_records_one_failed_outbound_attempt(self):
        model = ToolCallingFakeModel(responses=[])
        with self.assertRaises(SkillLearningRuntimeError):
            LangChainSkillProposalRuntime(model=model, ledger=self.ledger).propose(
                scope=self.scope, batch=self.batch)
        self.assertEqual(len(model.seen_calls), 1)
        entries = self.ledger.list_by_owner(self.scope.owner_id)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].outcome, LedgerOutcome.RUN_FAILED)

    def test_arbitrary_or_multiple_tool_requests_are_rejected_without_execution(self):
        for calls in ([{'id': 'synthetic-1', 'name': 'publish_skill', 'args': {}}],
                      [{'id': 'synthetic-1', 'name': 'SkillLearningProposal', 'args': {'outcome': 'no_change'}},
                       {'id': 'synthetic-2', 'name': 'SkillLearningProposal', 'args': {'outcome': 'no_change'}}]):
            with self.subTest(count=len(calls)):
                ledger = InMemoryOutboundLedger()
                model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=calls)])
                with self.assertRaises(SkillLearningInvalid):
                    LangChainSkillProposalRuntime(model=model, ledger=ledger).propose(scope=self.scope, batch=self.batch)
                self.assertEqual(len(model.seen_calls), 1)
                self.assertEqual(ledger.list_by_owner(self.scope.owner_id)[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION)

    def test_stopped_background_cannot_call_and_late_proposal_is_discarded(self):
        for stop_before in (True, False):
            with self.subTest(stop_before=stop_before):
                control = ModelPriorityControl()
                calls = []

                class ControlledProposal:
                    def propose(inner, **request):
                        calls.append(request)
                        control.stop()
                        return {'outcome': 'no_change'}

                if stop_before:
                    control.stop()
                runtime = PrioritySkillProposalRuntime(ControlledProposal(), control)
                with self.assertRaises(ModelWorkStopped):
                    runtime.propose(scope=self.scope, batch=self.batch)
                self.assertEqual(len(calls), 0 if stop_before else 1)

    def test_lease_guard_is_checked_before_and_after_learning_call(self):
        control = ModelPriorityControl()
        checks = []

        class Proposal:
            def propose(inner, **request):
                return {'outcome': 'no_change'}

        with control.background_scope(lambda: checks.append('checked')):
            result = PrioritySkillProposalRuntime(Proposal(), control).propose(scope=self.scope, batch=self.batch)
        self.assertEqual(result, {'outcome': 'no_change'})
        self.assertEqual(len(checks), 3)


if __name__ == '__main__':
    unittest.main()
