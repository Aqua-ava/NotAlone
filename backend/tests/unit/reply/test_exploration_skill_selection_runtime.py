"""自动策略选择的完整请求预算、实际出站台账及元数据边界。"""

import json
from dataclasses import replace
from unittest import TestCase
from uuid import uuid4

from langchain_core.messages import AIMessage

from notalone.ledger.models import LedgerOutcome
from notalone.reply.adapters.exploration_runtime import LangChainExplorationRuntime
from notalone.reply.exploration import ExplorationError
from notalone.reply.input_budget import InputBudgetExceededError, InputBudgetUnavailableError
from notalone.skills import SkillCatalog, SkillCatalogEntry
from tests.input_budget_support import synthetic_budget_kwargs
from tests.unit.reply.test_exploration_runtime import RecordingLedger, ToolSchemaModel, context


class ExplorationSkillSelectionRuntimeTest(TestCase):
    def setUp(self):
        self.context = context()
        self.version = uuid4()
        self.catalog = SkillCatalog(self.context.scope, 2, (SkillCatalogEntry(
            skill_id=uuid4(), version_id=self.version, name="synthetic-invitation",
            description="适用于当前收到邀请的主要沟通任务。", owner_id=self.context.scope.owner_id, contact_id=None,
        ),))
        self.ledger = RecordingLedger()

    def _model(self, version):
        return ToolSchemaModel(responses=[AIMessage(content="", tool_calls=[{
            "name": "ExplorationSkillSelection", "args": {"version_id": version}, "id": "synthetic-selection",
        }])])

    def test_selection_counts_the_exact_metadata_request_and_records_one_actual_call(self):
        model = self._model(str(self.version))
        configuration = synthetic_budget_kwargs(model, output_reserve=100)
        runtime = LangChainExplorationRuntime(model=model, ledger=self.ledger, **configuration)
        self.assertEqual(runtime.select_skill(self.context, self.catalog), self.version)
        self.assertEqual(configuration["input_token_counter"].seen_payloads, model.seen_model_payloads)
        actual = model.seen_model_payloads[0]
        payload = json.loads(actual["messages"][1]["content"])
        self.assertEqual(set(payload["skills"][0]), {"version_id", "name", "description"})
        self.assertNotIn("skill", payload)
        self.assertEqual(actual["tool_choice"], "ExplorationSkillSelection")
        self.assertEqual(actual["max_tokens"], 100)
        self.assertEqual(len(self.ledger.entries), 1)
        self.assertEqual(self.ledger.entries[0].outcome, LedgerOutcome.SUCCEEDED)

    def test_model_cannot_select_a_version_outside_the_authorized_directory(self):
        model = self._model(str(uuid4()))
        with self.assertRaises(ExplorationError):
            LangChainExplorationRuntime(model=model, ledger=self.ledger,
                **synthetic_budget_kwargs(model)).select_skill(self.context, self.catalog)
        self.assertEqual(len(model.seen_calls), 1)
        self.assertEqual(self.ledger.entries[0].outcome, LedgerOutcome.REJECTED_BY_VALIDATION)

    def test_unknown_or_exceeded_budget_blocks_selection_before_any_outbound(self):
        for unknown in (True, False):
            with self.subTest(unknown=unknown):
                model = self._model(None)
                configuration = {} if unknown else synthetic_budget_kwargs(model, capacity=500, output_reserve=100)
                with self.assertRaises(InputBudgetUnavailableError if unknown else InputBudgetExceededError):
                    LangChainExplorationRuntime(model=model, ledger=self.ledger,
                        **configuration).select_skill(self.context, self.catalog)
                self.assertEqual(model.seen_calls, [])
                self.assertEqual(self.ledger.entries, [])

    def test_current_input_guard_runs_before_selection_or_outbound_accounting(self):
        model = self._model(None)

        def invalidated():
            raise ExplorationError("合成输入已撤销。")

        with self.assertRaises(ExplorationError):
            LangChainExplorationRuntime(model=model, ledger=self.ledger,
                **synthetic_budget_kwargs(model)).select_skill(
                    replace(self.context, validate_current=invalidated), self.catalog)
        self.assertEqual(model.seen_calls, [])
        self.assertEqual(self.ledger.entries, [])
