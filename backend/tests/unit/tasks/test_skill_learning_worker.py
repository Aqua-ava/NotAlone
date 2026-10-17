"""既有Worker的学习步骤调度；数据库/模型边界合成，真实PG另验。"""

from datetime import datetime, timedelta, timezone
import unittest
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.application.skill_learning import SkillLearningTaskRunner
from notalone.ledger.adapters import InMemoryOutboundLedger
from notalone.scopes import ContactScope
from notalone.skills.learning import LearningBatch
from notalone.skills.learning_runtime import LangChainSkillProposalRuntime
from notalone.tasks.models import ClaimedBackgroundTaskStep, BackgroundTaskStepName
from notalone.tasks.worker import BackgroundTaskWorker, WorkerRunOutcome
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class TaskLeaseBoundary:
    def __init__(self, claim):
        self.claim, self.completed = claim, []

    def claim_next_step(self, **request):
        return self.claim if self.claim.name in request['supported_steps'] else None

    def complete_step(self, claim, *, processed_count, total_count):
        self.completed.append((claim.task_id, processed_count, total_count))

    def renew_step_lease(self, claim, **kwargs):
        pass


class LearningPersistenceBoundary:
    def __init__(self, batch):
        self.batch, self.saved, self.verified = batch, [], []

    def capture(self, scope):
        return self.batch

    def save(self, scope, claim, batch, proposal):
        self.saved.append((scope, claim.task_id, proposal))
        return len(batch.materials)

    def validate(self, scope, claim, batch):
        if batch != self.batch:
            raise ValueError('合成批次已变化。')

    def verify(self, scope):
        self.verified.append(scope)


class SkillLearningWorkerTest(unittest.TestCase):
    def test_fixed_worker_proposes_once_then_verifies_without_second_model_call(self):
        scope = ContactScope(uuid4(), uuid4())
        claim = ClaimedBackgroundTaskStep(uuid4(), scope.owner_id, scope.contact_id, None, uuid4(),
            BackgroundTaskStepName.PROPOSE_SKILL, uuid4(), 1, 1, datetime.now(timezone.utc) + timedelta(seconds=30))
        tasks = TaskLeaseBoundary(claim)
        store = LearningPersistenceBoundary(LearningBatch(({"priority": "correction", "content": {"correction": "合成纠正"}},), (), (), 0))
        model = ToolCallingFakeModel(responses=[AIMessage(content='', tool_calls=[{
            'id': 'synthetic-proposal', 'name': 'SkillLearningProposal', 'args': {'outcome': 'no_change'},
        }])])
        runtime = LangChainSkillProposalRuntime(model=model, ledger=InMemoryOutboundLedger())
        runner = SkillLearningTaskRunner(store=store, runtime=runtime)
        worker = BackgroundTaskWorker(repository=tasks, extraction_runner=object(), learning_runner=runner)
        result = worker.run_once(owner_id=scope.owner_id, contact_id=scope.contact_id, worker_id=claim.worker_id, task_id=claim.task_id)
        self.assertEqual(result.outcome, WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(result.processed_count, 1)
        self.assertEqual(store.saved, [(scope, claim.task_id, {'outcome': 'no_change'})])
        self.assertEqual(len(model.seen_calls), 1)
        from dataclasses import replace
        tasks.claim = replace(claim, name=BackgroundTaskStepName.VERIFY_SKILL_DRAFTS)
        self.assertEqual(worker.run_once(owner_id=scope.owner_id, contact_id=scope.contact_id, worker_id=claim.worker_id).outcome,
                         WorkerRunOutcome.SUCCEEDED)
        self.assertEqual(store.verified, [scope])
        self.assertEqual(len(model.seen_calls), 1)


if __name__ == '__main__':
    unittest.main()
