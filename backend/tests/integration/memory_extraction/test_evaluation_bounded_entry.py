"""固定15任务入口的离线控制；不访问真实凭据、网络或业务数据库。"""

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory_extraction import evaluation_ecnu as entry
from notalone.memory_extraction.evaluation_bounded_cases import (
    BOUNDED_RUNTIME_CASES, BOUNDED_RUNTIME_INPUTS, BOUNDED_RUNTIME_PLAN, BOUNDED_RUNTIME_REFERENCE_PATH,
    BOUNDED_RUNTIME_ANNOTATION_PATH,
)
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort
from notalone.memory_extraction.evaluation_owned_deadline import BoundedRuntime15Deadline
from notalone.memory_extraction.evaluation_phased_audit import PhasedEvaluationAudit
from notalone.memory_extraction.evaluation_provider_contract import ECNUEvaluationContract
from notalone.memory_extraction.evaluation_records import canonical_sha256
from notalone.tasks.extraction_runtime import runtime_config_for_mode
from notalone.tasks.models import (
    BackgroundTaskStatus, BackgroundTaskStepName, BackgroundTaskStepStatus,
    BackgroundTaskType, ExtractionRuntimeMode,
)
from tests.integration.memory_extraction import test_evaluation_ecnu as old_entry
from tests.unit.memory_extraction.test_evaluation_bounded_registration import bounded_config


class BoundedEvaluationEntryTest(unittest.TestCase):
    def setUp(self):
        old_entry.EvaluationECNUTest.setUp(self)
        self.stack.enter_context(patch("notalone.runtime_config._existing_env_path",
            side_effect=AssertionError("禁止读取dotenv")))

    def fixed(self):
        _, _, windows = bounded_config()
        self.task_ids = tuple(uuid4() for _ in windows)
        self.control = BoundedRuntime15Deadline(receipt=(self.output / "deadline.json").resolve(),
                                                clock=lambda: 0, exit_worker=lambda _: None)
        return dict(output_directory=self.output, run_id=uuid4(),
            deadline=datetime.now(timezone.utc) + timedelta(hours=4), repo_root=self.repo,
            source_hashes={}, frozen_gold={}, credential_loader=lambda: "synthetic-only",
            audit_case=lambda _: {}, synthetic_transport=httpx.MockTransport(lambda _: None),
            request_timeout_seconds=300, max_retries=0, case_set="bounded15",
            verification_mode="nullable-proof-v3", verification_tool_choice="forced",
            provider_profile="deepseek-bounded-task-v1", request_limit=30,
            extraction_mode="grounded-v2", execution_plan=BOUNDED_RUNTIME_PLAN,
            reference_version=BOUNDED_RUNTIME_PLAN, formal_windows=windows,
            formal_task_ids=self.task_ids, database_url="synthetic-persistence-seam",
            bounded_runtime_deadline=self.control)

    def test_old_entry_rejects_formal_arguments_before_budget_or_credentials(self):
        fixed = self.fixed()
        for changes in ({"execution_plan": "original"}, {"provider_profile": "ecnu"},
                        {"request_limit": 29}, {"verification_mode": "nullable-proof-v1"},
                        {"formal_windows": None}, {"bounded_runtime_deadline": object()}):
            with self.subTest(changes=changes), self.assertRaises(EvaluationBudgetAbort), \
                    patch.object(entry.EvaluationBudget, "create", side_effect=AssertionError("不得建账")):
                entry.run_ecnu_evaluation(**{**fixed, **changes})

    def test_only_new_profile_accepts_exact_registered_migration_path(self):
        relative = "backend/database/migrations/071_bounded_runtime_evidence.sql"
        path = self.repo / relative
        path.parent.mkdir(parents=True)
        path.write_text("-- 合成冻结迁移\n")
        hashes = {relative: hashlib.sha256(path.read_bytes()).hexdigest()}
        base = dict(deadline=datetime.now(timezone.utc) + timedelta(hours=1), repo_root=self.repo,
                    source_hashes=hashes)
        ECNUEvaluationContract(**base, provider_profile="deepseek-bounded-task-v1",
            execution_plan=BOUNDED_RUNTIME_PLAN, extraction_mode="grounded-v2")
        for profile in ("ecnu", "deepseek-flash-max"):
            with self.subTest(profile=profile), self.assertRaises(EvaluationBudgetAbort):
                ECNUEvaluationContract(**base, provider_profile=profile)
        for wrong in ("backend/database/migrations/061_unregistered.sql",
                      "backend/database/migrations/060_unregistered.sql", "backend/071_bounded_runtime_evidence.sql"):
            wrong_path = self.repo / wrong
            wrong_path.parent.mkdir(parents=True, exist_ok=True)
            wrong_path.write_bytes(path.read_bytes())
            with self.subTest(wrong=wrong), self.assertRaises(EvaluationBudgetAbort):
                ECNUEvaluationContract(**{**base, "source_hashes": {wrong: next(iter(hashes.values()))}},
                    provider_profile="deepseek-bounded-task-v1", execution_plan=BOUNDED_RUNTIME_PLAN,
                    extraction_mode="grounded-v2")

    def prepared(self):
        fixed = self.fixed()
        root = Path(__file__).resolve().parents[4]
        hashes = {}
        for relative in entry._BOUNDED_RUNTIME_REQUIRED_SOURCES:
            path = self.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            # 忽略的旧helper在这里只冻结合成源码，既不导入也不执行。
            content = ("# 合成公开helper\n".encode("utf-8") if relative.startswith("desktop/artifacts/")
                       else (root / relative).read_bytes())
            path.write_bytes(content)
            hashes[relative] = hashlib.sha256(content).hexdigest()
        reference = json.loads((self.repo / BOUNDED_RUNTIME_REFERENCE_PATH).read_text())
        criteria = hashes[BOUNDED_RUNTIME_REFERENCE_PATH]
        audit = PhasedEvaluationAudit(reference=reference, expected_reference_sha256=canonical_sha256(reference),
            annotation_sha256=hashes[BOUNDED_RUNTIME_ANNOTATION_PATH], criteria_sha256=criteria,
            raw_reviewer=lambda _: self.fail("本入口接缝控制不认证模型审核"), full_reviewer=lambda _: {},
            case_set="bounded15", verification_mode="nullable-proof-v3", verification_tool_choice="forced",
            extraction_tool_choice="omitted", extraction_mode="grounded-v2",
            reference_version=BOUNDED_RUNTIME_PLAN, execution_plan=BOUNDED_RUNTIME_PLAN)
        fixed.update(source_hashes=hashes, frozen_gold={"status": "frozen_agent_review",
            "case_names": [case.name for case in BOUNDED_RUNTIME_CASES],
            "criteria_path": BOUNDED_RUNTIME_REFERENCE_PATH, "criteria_sha256": criteria}, audit_case=audit)
        config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        self.tasks = {}
        for window, task_id, source in zip(fixed["formal_windows"], self.task_ids, BOUNDED_RUNTIME_INPUTS):
            self.tasks[task_id] = SimpleNamespace(task_id=task_id, owner_id=window.owner_id,
                contact_id=window.contact_id, extraction_runtime_config=config, retry_count=0,
                task_type=BackgroundTaskType.IMPORT if source["source_route"] == "jsonl" else BackgroundTaskType.OBSERVATION,
                status=BackgroundTaskStatus.QUEUED, steps=(SimpleNamespace(
                    name=BackgroundTaskStepName.EXTRACT_MEMORY, status=BackgroundTaskStepStatus.PENDING,
                    attempt_count=0),))
        repository = self.stack.enter_context(patch(
            "notalone.persistence.background_tasks.PostgresBackgroundTaskRepository")).return_value
        self.read_tasks = []

        def get_task(**values):
            self.read_tasks.append(values)
            return self.tasks[values["task_id"]]

        repository.get_task.side_effect = get_task
        self.stack.enter_context(patch("notalone.persistence.extraction_trace.PostgresExtractionTraceStore")) \
            .return_value.list_batches.return_value = ()
        self.read_windows = self.stack.enter_context(patch(
            "notalone.memory_extraction.evaluation_formal_task._task_window", side_effect=lambda _, window, case: window))
        return fixed

    def test_fixed_entry_freezes_all_tasks_then_claims_before_single_loader_and_real_sdk_wire(self):
        from langchain_deepseek import ChatDeepSeek
        from pydantic import SecretStr

        fixed = self.prepared()
        wires = []
        original_start = self.control.start
        self.started = False

        def start(budget, **kwargs):
            self.assertEqual(len(self.read_tasks), 15)
            self.assertEqual(self.read_windows.call_count, 15)
            self.assertTrue((self.home / ".notalone-memory-evaluations" / str(fixed["run_id"]) / "claimed").is_file())
            original_start(budget, **kwargs)
            self.started = True

        def credential():
            self.assertTrue(self.started)
            self.credentials.append("synthetic")
            return "synthetic-only"

        def batch(**values):
            self.assertEqual(values["windows"], fixed["formal_windows"])
            self.assertIs(values["semantic_audit"], fixed["audit_case"])
            self.assertEqual(values["formal_task_ids"], self.task_ids)
            self.assertEqual(values["database_url"], fixed["database_url"])
            self.assertEqual(values["store"].gold_sha256, fixed["audit_case"].reference_sha256)
            contract = values["contract"]

            def respond(request):
                contract.check_request(request)
                body = json.loads(request.content)
                wires.append(body)
                response = old_entry.EvaluationECNUTest.response(self, request,
                    reported_model="deepseek-flash", arguments={})
                contract.observe_response(response)
                return response

            async_client = httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False)
            self.addCleanup(lambda: asyncio.run(async_client.aclose()))
            with values["budget"].batch(), \
                    httpx.Client(transport=httpx.MockTransport(respond), trust_env=False) as client:
                key = values["credential_loader"]()
                with self.assertRaisesRegex(EvaluationBudgetAbort, "already_loaded"):
                    values["credential_loader"]()
                for purpose in ("extraction", "verification"):
                    verification = purpose == "verification"
                    prompt, schema = (entry._verification_contract("nullable-proof-v3") if verification
                        else entry.extraction_contract("grounded-v2", fixed["formal_windows"][0]))
                    messages = [{"role": "system", "content": prompt}, {"role": "user", "content": "合成调用控制"}]
                    model = ChatDeepSeek(api_key=SecretStr(key), model="deepseek-flash", base_url="https://api.deepseek.com",
                        temperature=0.0, timeout=300, max_retries=0, http_client=client, http_async_client=async_client,
                        extra_body={"thinking": {"type": "disabled" if verification else "enabled"},
                                    "reasoning_effort": "none" if verification else "max"})
                    with values["invocation_scope"](purpose, messages, fixed["formal_windows"][0]):
                        model.bind_tools([schema], **({"tool_choice": schema["title"]} if verification else {})).invoke(messages)
            return {"quality_certified": False, "receipt": {"budget": values["budget"].closed_receipt()}}

        with patch.object(self.control, "start", side_effect=start), \
                patch.object(entry, "_run_evaluation_batch", side_effect=batch):
            result = entry.run_ecnu_evaluation(**{**fixed, "credential_loader": credential})
        self.assertEqual(self.credentials, ["synthetic"])
        self.assertEqual(len(wires), 2)
        self.assertNotIn("tool_choice", wires[0])
        self.assertEqual(wires[1]["tool_choice"]["function"]["name"], "SourceVerificationOutput")
        self.assertEqual(wires[0]["reasoning_effort"], "max")
        self.assertEqual(wires[1]["reasoning_effort"], "none")
        self.assertEqual(result["execution_plan"], BOUNDED_RUNTIME_PLAN)
        self.assertFalse(result["quality_certified"])
        self.assertTrue(result["receipt"]["budget"]["closed"])
        self.assertTrue(self.control._stop.is_set())

    def test_persisted_task_or_actual_source_mismatch_rejects_before_budget(self):
        fixed = self.prepared()
        self.tasks[self.task_ids[-1]].extraction_runtime_config = runtime_config_for_mode(ExtractionRuntimeMode.LEGACY)
        with patch.object(entry.EvaluationBudget, "create", side_effect=AssertionError("不得建账")), \
                self.assertRaisesRegex(EvaluationBudgetAbort, "formal_source_mismatch"):
            entry.run_ecnu_evaluation(**fixed)
        self.tasks[self.task_ids[-1]].extraction_runtime_config = runtime_config_for_mode(ExtractionRuntimeMode.BOUNDED_RUNTIME_V1)
        self.read_windows.side_effect = ValueError("合成默认窗口不一致")
        with patch.object(entry.EvaluationBudget, "create", side_effect=AssertionError("不得建账")), \
                self.assertRaisesRegex(ValueError, "合成默认窗口不一致"):
            entry.run_ecnu_evaluation(**fixed)

    def test_added_source_and_changed_gold_reject_before_budget(self):
        fixed = self.prepared()
        extra = self.repo / "backend/src/notalone/unregistered.py"
        extra.write_text("# 合成新增源码\n")
        with patch.object(entry.EvaluationBudget, "create", side_effect=AssertionError("不得建账")), \
                self.assertRaisesRegex(EvaluationBudgetAbort, "source_inventory_changed"):
            entry.run_ecnu_evaluation(**fixed)
        extra.unlink()
        fixed["frozen_gold"]["criteria_sha256"] = "0" * 64
        with patch.object(entry.EvaluationBudget, "create", side_effect=AssertionError("不得建账")), \
                self.assertRaisesRegex(EvaluationBudgetAbort, "reference_invalid"):
            entry.run_ecnu_evaluation(**fixed)

    def test_source_inventory_and_package_versions_are_rechecked_before_each_invocation(self):
        fixed = self.prepared()

        def batch(**values):
            window = fixed["formal_windows"][0]
            prompt, _ = entry.extraction_contract("grounded-v2", window)
            messages = [{"role": "system", "content": prompt}]
            with values["budget"].batch():
                values["credential_loader"]()
                extra = self.repo / "backend/src/notalone/unregistered.py"
                extra.write_text("# 合成运行中新增\n")
                with self.assertRaisesRegex(EvaluationBudgetAbort, "source_inventory_changed"):
                    with values["invocation_scope"]("extraction", messages, window):
                        self.fail("源码变化后不得调用")
                extra.unlink()
                with patch.object(entry, "version", return_value="synthetic-changed"), \
                        self.assertRaisesRegex(EvaluationBudgetAbort, "package_versions_changed"):
                    with values["invocation_scope"]("extraction", messages, window):
                        self.fail("版本变化后不得调用")
            return {"quality_certified": False, "receipt": {"budget": values["budget"].closed_receipt()}}

        with patch.object(entry, "_run_evaluation_batch", side_effect=batch):
            result = entry.run_ecnu_evaluation(**fixed)
        self.assertTrue(result["receipt"]["budget"]["closed"])

    def test_credential_failure_closes_original_budget_and_finishes_watchdog_without_retry(self):
        fixed = self.prepared()
        captured = []

        def batch(**values):
            captured.append(values["budget"])
            with values["budget"].batch():
                values["credential_loader"]()

        def unavailable():
            self.credentials.append("one synthetic attempt")
            raise ValueError("synthetic-unavailable")

        with patch.object(entry, "_run_evaluation_batch", side_effect=batch), \
                self.assertRaisesRegex(ValueError, "synthetic-unavailable"):
            entry.run_ecnu_evaluation(**{**fixed, "credential_loader": unavailable})
        self.assertEqual(self.credentials, ["one synthetic attempt"])
        self.assertTrue(captured[0].closed_receipt()["closed"])
        self.assertEqual(captured[0].closed_receipt()["reserved_requests"], 0)
        self.assertTrue(self.control._stop.is_set())
