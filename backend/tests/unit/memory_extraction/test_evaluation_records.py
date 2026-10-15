"""评测结果私有持久化接缝，只使用合成正文和临时目录。"""

from __future__ import annotations

import tempfile
import json
import asyncio
import base64
import os
import stat
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationBudget,
    EvaluationBudgetAbort,
    EvaluationAsyncTransport,
    EvaluationTransport,
)
from notalone.memory_extraction.evaluation_records import (
    EvaluationRecordStore,
    canonical_sha256,
)


ENDPOINT = "https://evaluation.invalid/v1/chat/completions"


class EvaluationRecordsTest(unittest.TestCase):
    def _store(self, home: Path):
        output = home / "output"
        output.mkdir(mode=0o700)
        plan = ({"case_position": 0, "case_name": "合成空候选", "input_sha256": "a" * 64},)
        config = {"mode": "offline_mock", "plan_sha256": canonical_sha256(plan)}
        budget = EvaluationBudget.create(
            run_id=uuid4(), output_directory=output, request_limit=3,
            allowed_endpoints=(ENDPOINT,),
            config_sha256=canonical_sha256(config),
        )
        return budget, EvaluationRecordStore(
            budget=budget, frozen_config=config, plan=plan,
        )

    def test_request_is_durable_before_dispatch_and_response_before_return(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))

                def synthetic(request):
                    self.assertEqual(
                        [event["kind"] for event in records.events()],
                        ["provider_request"],
                    )
                    return httpx.Response(200, json={"choices": [], "model": "synthetic"})

                with budget.batch(), records.stage(0, "extraction"):
                    with httpx.Client(
                        transport=EvaluationTransport(
                            budget, records=records,
                            synthetic_transport=httpx.MockTransport(synthetic),
                        ), trust_env=False,
                    ) as client:
                        response = client.post(
                            ENDPOINT,
                            json={"model": "synthetic", "messages": []},
                        )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(
                        [event["kind"] for event in records.events()],
                        ["provider_request", "provider_response"],
                    )

    def test_all_allowed_tools_are_retained_without_thought_or_header_bypass(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                body = {"choices": [{"message": {
                    "reasoning_content": "synthetic-private-thought",
                    "tool_calls": [{"function": {"name": "MemoryExtractionOutput", "arguments": json.dumps({
                        "facts": [{"interpretation_reason": "允许保存的短理由"}],
                        "reasoning_content": "synthetic-encoded-thought",
                    })}}, {"function": {"name": "extra-tool", "arguments": "{}"}}],
                }}]}
                with budget.batch(), records.stage(0, "extraction"):
                    with httpx.Client(
                        transport=EvaluationTransport(
                            budget, records=records,
                            synthetic_transport=httpx.MockTransport(lambda request: httpx.Response(
                                200, json=body, headers={"x-private": "synthetic-header-secret"},
                            )),
                        ), trust_env=False,
                    ) as client:
                        client.post(
                            ENDPOINT,
                            json={"model": "synthetic", "messages": [], "thinking": {"type": "enabled"}},
                            headers={"Authorization": "synthetic-request-secret"},
                        )
                    events = records.events()
                persisted = json.dumps(events, ensure_ascii=False)
                for marker in (
                    "synthetic-private-thought", "synthetic-encoded-thought",
                    "synthetic-header-secret", "synthetic-request-secret",
                ):
                    self.assertNotIn(marker, persisted)
                self.assertIn("允许保存的短理由", persisted)
                response = events[1]["payload"]
                self.assertEqual(response["capture_form"], "redacted_json")
                self.assertEqual(len(response["body"]["choices"][0]["message"]["tool_calls"]), 2)
                self.assertEqual(events[0]["payload"]["body"]["thinking"], {"type": "enabled"})

    def test_completion_requires_real_closed_budget_and_full_plan_accounting(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                with self.assertRaises(EvaluationBudgetAbort):
                    budget.closed_receipt()
                with budget.batch(), records.stage(0, "case"):
                    records.record(kind="case_started", payload={})
                    records.record(kind="case_result", payload={"empty": True})
                receipt = records.finalize(
                    outcomes=({"case_position": 0, "case_name": "合成空候选", "input_sha256": "a" * 64, "status": "empty", "result": {"empty": True}},),
                    budget_closed=True,
                )
                self.assertTrue(receipt["budget"]["closed"])
                self.assertEqual(receipt["budget"]["reserved_requests"], 0)
                self.assertTrue(receipt["plan_complete"])
                self.assertFalse(receipt["quality_certified"])

    def test_repeated_finalize_returns_same_verified_immutable_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                with budget.batch():
                    pass
                outcomes = ({
                    "case_position": 0, "case_name": "合成空候选",
                    "input_sha256": "a" * 64, "status": "unrun",
                },)
                original = records.finalize(outcomes=outcomes, budget_closed=True)
                first_bytes = (home / "output/completion.json").read_bytes()
                original["outcomes"][0]["status"] = "completed"
                repeated = records.finalize(outcomes=outcomes, budget_closed=True)
                self.assertEqual(repeated["outcomes"][0]["status"], "unrun")
                self.assertEqual((home / "output/completion.json").read_bytes(), first_bytes)
                changed = json.loads(first_bytes)
                changed["quality_certified"] = True
                (home / "output/completion.json").write_text(json.dumps(changed))
                with self.assertRaises(EvaluationBudgetAbort):
                    records.finalize(outcomes=outcomes, budget_closed=True)

    def test_capture_gap_receipt_cannot_resume_events_or_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                sent = []
                with self.assertRaises(EvaluationBudgetAbort):
                    with budget.batch(), records.stage(0, "case"):
                        records.record(kind="case_started", payload={})
                        with httpx.Client(transport=EvaluationTransport(
                            budget, records=records,
                            synthetic_transport=httpx.MockTransport(
                                lambda request: sent.append(request) or httpx.Response(
                                    500, content=b"synthetic-opaque-500!",
                                ),
                            ),
                        ), trust_env=False) as client:
                            client.post(ENDPOINT, json={})
                outcomes = ({
                    "case_position": 0, "case_name": "合成空候选",
                    "input_sha256": "a" * 64, "status": "unknown",
                },)
                receipt = records.finalize(outcomes=outcomes, budget_closed=True)
                original = (home / "output/completion.json").read_bytes()
                with records.stage(0, "extraction"):
                    with self.assertRaises(EvaluationBudgetAbort):
                        records.record(kind="provider_request", payload={})
                    with httpx.Client(transport=EvaluationTransport(
                        budget, records=records,
                        synthetic_transport=httpx.MockTransport(
                            lambda request: sent.append(request) or httpx.Response(200),
                        ),
                    ), trust_env=False) as client:
                        with self.assertRaises(EvaluationBudgetAbort):
                            client.post(ENDPOINT, json={})
                self.assertEqual(len(sent), 1)
                self.assertEqual(len(records.events()), 3)
                self.assertEqual(records.finalize(outcomes=outcomes, budget_closed=True), receipt)
                self.assertEqual((home / "output/completion.json").read_bytes(), original)

    def test_capture_gap_does_not_authorize_retrying_failed_terminal_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                with self.assertRaises(EvaluationBudgetAbort):
                    with budget.batch(), records.stage(0, "case"):
                        records.record(kind="case_started", payload={})
                        with httpx.Client(transport=EvaluationTransport(
                            budget, records=records,
                            synthetic_transport=httpx.MockTransport(
                                lambda request: httpx.Response(500, content=b"opaque"),
                            ),
                        ), trust_env=False) as client:
                            client.post(ENDPOINT, json={})
                outcomes = ({
                    "case_position": 0, "case_name": "合成空候选",
                    "input_sha256": "a" * 64, "status": "unknown",
                },)
                real_open = os.open

                def fault(path, *args, **kwargs):
                    if str(path) == "completion.json":
                        raise OSError("synthetic terminal storage fault")
                    return real_open(path, *args, **kwargs)

                with patch.object(os, "open", side_effect=fault):
                    with self.assertRaises(EvaluationBudgetAbort):
                        records.finalize(outcomes=outcomes, budget_closed=True)
                with self.assertRaises(EvaluationBudgetAbort):
                    records.finalize(outcomes=outcomes, budget_closed=True)
                self.assertFalse((home / "output/completion.json").exists())
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)

    def test_non_http_metadata_cannot_be_reported_as_a_capture_gap(self):
        for payload in (None, {"body_not_saved": "合成非HTTP字段"}):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                with patch.object(Path, "home", return_value=home):
                    budget, records = self._store(home)
                    with budget.batch(), records.stage(0, "case"):
                        records.record(kind="case_started", payload=payload)
                    receipt = records.finalize(outcomes=({
                        "case_position": 0, "case_name": "合成空候选",
                        "input_sha256": "a" * 64, "status": "unknown",
                    },), budget_closed=True)
                    self.assertEqual(receipt["capture_gaps"], [])

    def test_opaque_response_records_gap_and_digest_without_persisting_thought(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                with self.assertRaises(EvaluationBudgetAbort):
                    with budget.batch(), records.stage(0, "extraction"):
                        with httpx.Client(
                            transport=EvaluationTransport(
                                budget, records=records,
                                synthetic_transport=httpx.MockTransport(lambda request: httpx.Response(
                                    200, content=b'{"reasoning_content":"synthetic-unparseable-thought"',
                                )),
                            ), trust_env=False,
                        ) as client:
                            client.post(
                                ENDPOINT,
                                json={"model": "synthetic", "messages": []},
                            )
                events = records.events()
                self.assertEqual(len(events), 2)
                self.assertEqual(events[1]["payload"]["body_not_saved"], "redaction_unavailable")
                self.assertNotIn("synthetic-unparseable-thought", json.dumps(events))
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 1)

    def test_request_write_or_fsync_fault_stops_before_dispatch(self):
        for fault_kind in ("write", "file_fsync", "directory_fsync"):
            with self.subTest(fault_kind=fault_kind), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                with patch.object(Path, "home", return_value=home):
                    budget, records = self._store(home)
                    run_id = UUID(budget.snapshot()["run_id"])
                    output_identity = (home / "output").stat()
                    sent = []
                    real_open, real_fsync = os.open, os.fsync

                    def open_fault(path, *args, **kwargs):
                        if fault_kind == "write" and str(path) == "event-000001.json":
                            raise OSError("synthetic write fault")
                        return real_open(path, *args, **kwargs)

                    def fsync_fault(descriptor):
                        value = os.fstat(descriptor)
                        is_output = (value.st_dev, value.st_ino) == (
                            output_identity.st_dev, output_identity.st_ino
                        )
                        if (
                            fault_kind == "file_fsync" and stat.S_ISREG(value.st_mode)
                        ) or (fault_kind == "directory_fsync" and is_output):
                            raise OSError("synthetic fsync fault")
                        return real_fsync(descriptor)

                    with budget.batch(), records.stage(0, "extraction"):
                        with httpx.Client(transport=EvaluationTransport(
                            budget, records=records, synthetic_transport=httpx.MockTransport(
                                lambda request: sent.append(request) or httpx.Response(200, json={}),
                            ),
                        ), trust_env=False) as client:
                            with (
                                patch.object(os, "open", side_effect=open_fault),
                                patch.object(os, "fsync", side_effect=fsync_fault),
                            ):
                                with self.assertRaises(EvaluationBudgetAbort):
                                    client.post(ENDPOINT, json={})
                            with self.assertRaises(EvaluationBudgetAbort):
                                client.post(ENDPOINT, json={})
                    self.assertEqual(sent, [])
                    self.assertEqual(records.events(), ())
                    with self.assertRaises(EvaluationBudgetAbort):
                        EvaluationBudget.open(run_id=run_id)

    def test_response_write_fault_keeps_request_and_refuses_later_dispatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                sent = []
                real_open = os.open

                def fault(path, *args, **kwargs):
                    if str(path) == "event-000002.json":
                        raise OSError("synthetic response save fault")
                    return real_open(path, *args, **kwargs)

                with budget.batch(), records.stage(0, "extraction"):
                    with httpx.Client(transport=EvaluationTransport(
                        budget, records=records, synthetic_transport=httpx.MockTransport(
                            lambda request: sent.append(request) or httpx.Response(200, json={}),
                        ),
                    ), trust_env=False) as client:
                        with patch.object(os, "open", side_effect=fault):
                            with self.assertRaises(EvaluationBudgetAbort):
                                client.post(ENDPOINT, json={})
                        with self.assertRaises(EvaluationBudgetAbort):
                            client.post(ENDPOINT, json={})
                self.assertEqual(len(sent), 1)
                self.assertEqual([event["kind"] for event in records.events()], ["provider_request"])
                with self.assertRaises(EvaluationBudgetAbort):
                    records.finalize(
                        outcomes=({
                            "case_position": 0, "case_name": "合成空候选",
                            "input_sha256": "a" * 64, "status": "unknown",
                        },), budget_closed=True,
                    )

    def test_event_symlink_or_hardlink_is_refused_without_overwriting_target(self):
        for link_kind in ("symlink", "hardlink"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                with patch.object(Path, "home", return_value=home):
                    budget, records = self._store(home)
                    target = home / "synthetic-target"
                    target.write_text("不可覆盖的合成目标")
                    target.chmod(0o600)
                    event = home / "output" / "event-000001.json"
                    if link_kind == "symlink":
                        event.symlink_to(target)
                    else:
                        os.link(target, event)
                    with budget.batch(), records.stage(0, "case"):
                        with self.assertRaises(EvaluationBudgetAbort):
                            records.record(kind="case_started", payload={})
                    self.assertEqual(target.read_text(), "不可覆盖的合成目标")

    def test_completion_write_fault_never_returns_a_completion_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                with budget.batch():
                    pass
                real_open = os.open

                def fault(path, *args, **kwargs):
                    if str(path) == "completion.json":
                        raise OSError("synthetic completion fault")
                    return real_open(path, *args, **kwargs)

                with patch.object(os, "open", side_effect=fault):
                    with self.assertRaises(EvaluationBudgetAbort):
                        records.finalize(
                            outcomes=({
                                "case_position": 0, "case_name": "合成空候选",
                                "input_sha256": "a" * 64, "status": "unrun",
                            },), budget_closed=True,
                        )
                self.assertFalse((home / "output" / "completion.json").exists())

    def test_completed_outcome_without_recorded_result_cannot_sign_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                with budget.batch():
                    pass
                with self.assertRaises(EvaluationBudgetAbort):
                    records.finalize(
                        outcomes=({
                            "case_position": 0, "case_name": "合成空候选",
                            "input_sha256": "a" * 64, "status": "completed",
                        },),
                        budget_closed=True,
                    )

    def test_changed_event_attribution_is_rejected_even_if_payload_hash_matches(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                with budget.batch(), records.stage(0, "case"):
                    records.record(kind="case_started", payload={})
                    path = home / "output" / "event-000001.json"
                    event = json.loads(path.read_bytes())
                    event["case_name"] = "篡改的合成归属"
                    path.write_text(json.dumps(event))
                    with self.assertRaises(EvaluationBudgetAbort):
                        records.events()

    def test_async_timeout_and_response_have_separate_durable_sequences(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(Path, "home", return_value=Path(temporary)):
                budget, records = self._store(Path(temporary))
                calls = []

                async def synthetic(request):
                    calls.append(budget.snapshot()["reserved_requests"])
                    if len(calls) == 1:
                        raise httpx.ReadTimeout("synthetic-secret-not-for-log")
                    return httpx.Response(200, json={"choices": []})

                async def perform():
                    with budget.batch(), records.stage(0, "extraction"):
                        async with httpx.AsyncClient(
                            transport=EvaluationAsyncTransport(
                                budget, records=records,
                                synthetic_transport=httpx.MockTransport(synthetic),
                            ), trust_env=False,
                        ) as client:
                            with self.assertRaises(httpx.ReadTimeout):
                                await client.post(ENDPOINT, json={})
                            response = await client.post(ENDPOINT, json={})
                            self.assertEqual(response.status_code, 200)

                asyncio.run(perform())
                events = records.events()
                self.assertEqual(calls, [1, 2])
                self.assertEqual([event["request_sequence"] for event in events], [1, 1, 2, 2])
                self.assertEqual(events[1]["payload"]["failure_kind"], "read_timeout")
                self.assertNotIn("synthetic-secret-not-for-log", json.dumps(events))
                self.assertEqual(budget.closed_receipt()["reserved_requests"], 2)

    def test_credentials_are_rejected_before_the_frozen_manifest_is_saved(self):
        for private_key in ("api_key", "password", "access_token", "unknown_config", "base_url"):
            with self.subTest(private_key=private_key), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                with patch.object(Path, "home", return_value=home):
                    output = home / "output"
                    output.mkdir(mode=0o700)
                    plan = ({"case_position": 0, "case_name": "合成", "input_sha256": "a" * 64},)
                    config = {
                        "plan_sha256": canonical_sha256(plan),
                        private_key: (
                            "https://synthetic:synthetic-private-config@evaluation.invalid/v1"
                            if private_key == "base_url" else "synthetic-private-config"
                        ),
                    }
                    budget = EvaluationBudget.create(
                        run_id=uuid4(), output_directory=output, request_limit=1,
                        allowed_endpoints=(ENDPOINT,),
                        config_sha256=canonical_sha256(config),
                    )
                    with self.assertRaises(EvaluationBudgetAbort):
                        EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)
                    self.assertFalse((output / "manifest.json").exists())

    def test_double_encoded_or_base64_arguments_leave_only_a_gap_and_stop(self):
        secret = json.dumps({"reasoning_content": "synthetic-nested-thought"})
        arguments = (
            json.dumps(secret),
            base64.b64encode(secret.encode()).decode(),
        )
        for encoded in arguments:
            with self.subTest(encoded_kind=encoded[:8]), tempfile.TemporaryDirectory() as temporary:
                with patch.object(Path, "home", return_value=Path(temporary)):
                    budget, records = self._store(Path(temporary))
                    body = {"choices": [{"message": {"tool_calls": [{"function": {
                        "name": "MemoryExtractionOutput", "arguments": encoded,
                    }}]}}]}
                    with self.assertRaises(EvaluationBudgetAbort):
                        with budget.batch(), records.stage(0, "extraction"):
                            with httpx.Client(transport=EvaluationTransport(
                                budget, records=records, synthetic_transport=httpx.MockTransport(
                                    lambda request: httpx.Response(200, json=body),
                                ),
                            ), trust_env=False) as client:
                                client.post(ENDPOINT, json={})
                    events = records.events()
                    self.assertEqual(events[1]["payload"]["capture_form"], "digest_only")
                    self.assertNotIn(encoded, json.dumps(events))
                    self.assertNotIn("synthetic-nested-thought", json.dumps(events))

    def test_completion_rejects_failure_upgrade_changed_input_or_result(self):
        for changed in ("failure_upgrade", "input", "result"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                with patch.object(Path, "home", return_value=Path(temporary)):
                    budget, records = self._store(Path(temporary))
                    result = {"failure_reason": "合成调用失败" if changed == "failure_upgrade" else None}
                    with budget.batch(), records.stage(0, "case"):
                        records.record(kind="case_started", payload={})
                        records.record(kind="case_result", payload=result)
                    outcome = {
                        "case_position": 0, "case_name": "合成空候选",
                        "input_sha256": "b" * 64 if changed == "input" else "a" * 64,
                        "status": "completed",
                        "result": {"failure_reason": "篡改的结果"} if changed == "result" else result,
                    }
                    with self.assertRaises(EvaluationBudgetAbort):
                        records.finalize(outcomes=(outcome,), budget_closed=True)

    def test_completion_uses_the_same_thought_and_header_redaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.object(Path, "home", return_value=home):
                budget, records = self._store(home)
                result = {
                    "failure_reason": None,
                    "reasoning_content": "synthetic-completion-thought",
                    "headers": {"Authorization": "synthetic-completion-credential"},
                }
                with budget.batch(), records.stage(0, "case"):
                    records.record(kind="case_started", payload={})
                    records.record(kind="case_result", payload=result)
                receipt = records.finalize(outcomes=({
                    "case_position": 0, "case_name": "合成空候选",
                    "input_sha256": "a" * 64, "status": "completed",
                    "result": result,
                    "headers": {"Authorization": "synthetic-extra-header"},
                },), budget_closed=True)
                persisted = (home / "output" / "completion.json").read_text()
                for marker in ("synthetic-completion-thought", "synthetic-completion-credential", "synthetic-extra-header"):
                    self.assertNotIn(marker, persisted)
                self.assertTrue(receipt["removed_paths"])
                self.assertTrue(receipt["plan_complete"])


class Full140V4RecordContractTest(unittest.TestCase):
    def config_plan(self):
        from notalone.memory_extraction.evaluation import build_window
        from notalone.memory_extraction.evaluation_cases import CASES
        from notalone.memory_extraction.evaluation_extraction import extraction_contract
        from notalone.memory_extraction.evaluation_reference import public_window_projection
        from notalone.memory_extraction.semantic_evaluation_cases import SEMANTIC_CASES

        cases = (*CASES, *SEMANTIC_CASES)
        windows = tuple(build_window(case) for case in cases)
        plan = tuple({"case_position": i, "case_name": case.name,
                      "input_sha256": canonical_sha256(public_window_projection(window))}
                     for i, (case, window) in enumerate(zip(cases, windows)))
        contracts = [extraction_contract("grounded-v4", window) for window in windows]
        config = {
            "mode": "deepseek_bounded_full140_v4_source_v2", "stage": "full140-v4-source-v2",
            "execution_plan": "full140-grounded-v4-source-v2", "reference_version": "source-fidelity-v2",
            "extraction_mode": "grounded-v4", "verification_mode": "nullable-proof-v1",
            "tool_choice": {
                "extraction": {"mode": "omitted", "name": "GroundedMemoryLabelsV4"},
                "verification": {"mode": "omitted", "name": "SourceVerificationOutput"},
            }, "max_retries": 0,
            "selected_case_positions": list(range(140)), "plan_sha256": canonical_sha256(plan),
            "extraction_window_contracts": [
                {"input_sha256": item["input_sha256"], "prompt_sha256": canonical_sha256(prompt),
                 "schema_sha256": canonical_sha256(schema)}
                for item, (prompt, schema) in zip(plan, contracts)
            ],
        }
        return config, plan

    def store(self, folder, config, plan, cap=280):
        output = folder / "output"
        output.mkdir(mode=0o700)
        budget = EvaluationBudget.create(
            run_id=uuid4(), output_directory=output, request_limit=cap,
            allowed_endpoints=(ENDPOINT,), config_sha256=canonical_sha256(config),
        )
        return budget, EvaluationRecordStore(budget=budget, frozen_config=config, plan=plan)

    def test_v4_complete_plan_exposes_frozen_reference_version(self):
        config, plan = self.config_plan()
        with tempfile.TemporaryDirectory() as temporary, patch.object(Path, "home", return_value=Path(temporary)):
            _, store = self.store(Path(temporary), config, plan)
            self.assertEqual(store.reference_version, "source-fidelity-v2")
            self.assertEqual(store.extraction_mode, "grounded-v4")
            for position in (0, 139):
                self.assertEqual(store.extraction_contract_hashes(position), {
                    key: config["extraction_window_contracts"][position][key]
                    for key in ("prompt_sha256", "schema_sha256")
                })

    def test_fixed_v4_registration_rejects_scope_and_version_drift(self):
        from copy import deepcopy

        original, original_plan = self.config_plan()
        changes = (
            ("execution_plan", None), ("reference_version", None),
            ("execution_plan", "reference21-main16-v3"), ("reference_version", "legacy-v1"),
            ("mode", "offline_mock"), ("stage", "full140"), ("extraction_mode", "grounded-v3"),
            ("verification_mode", "legacy-v4"), ("tool_choice", "forced"), ("max_retries", 1),
            ("selected_case_positions", list(range(139))), ("cap", 281), ("partial", True),
            ("swapped", True), ("contracts", True),
        )
        for key, value in changes:
            config, plan, cap = deepcopy(original), original_plan, 280
            if key == "cap":
                cap = value
            elif key == "partial":
                plan = plan[:-1]
                config["plan_sha256"] = canonical_sha256(plan)
                config["extraction_window_contracts"] = config["extraction_window_contracts"][:-1]
            elif key == "swapped":
                plan = tuple({**item, "case_position": i} for i, item in enumerate((*plan[1:2], *plan[:1], *plan[2:])))
                config["plan_sha256"] = canonical_sha256(plan)
                config["extraction_window_contracts"][0:2] = list(reversed(config["extraction_window_contracts"][0:2]))
            elif key == "contracts":
                config["extraction_window_contracts"][-1]["input_sha256"] = "f" * 64
            elif value is None:
                del config[key]
            else:
                config[key] = value
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)), self.assertRaises(EvaluationBudgetAbort):
                self.store(Path(temporary), config, plan, cap=cap)

    def test_legacy_records_omitted_reference_fields_keep_legacy_property(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(Path, "home", return_value=Path(temporary)):
            _, store = EvaluationRecordsTest()._store(Path(temporary))
            self.assertEqual(store.reference_version, "legacy-v1")

    def test_fixed_v4_plan_rejects_boolean_and_float_positions_even_with_fresh_hashes(self):
        from copy import deepcopy

        original, original_plan = self.config_plan()
        for position, impostor in ((0, False), (0, 0.0), (1, True), (1, 1.0)):
            config = deepcopy(original)
            plan = tuple({**item, **({"case_position": impostor} if index == position else {})}
                         for index, item in enumerate(original_plan))
            config["plan_sha256"] = canonical_sha256(plan)
            with self.subTest(position=position, impostor=impostor), \
                    tempfile.TemporaryDirectory() as temporary, \
                    patch.object(Path, "home", return_value=Path(temporary)):
                with self.assertRaisesRegex(EvaluationBudgetAbort, "invalid_record_full140_v4_registration"):
                    self.store(Path(temporary), config, plan)
                self.assertFalse((Path(temporary) / "output/manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
