"""既有公开入口的正式15窗准备控制，不启动模型或读取凭据。"""

from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from notalone.memory_extraction.evaluation_http_budget import EvaluationBudget


ROOT = Path(__file__).resolve().parents[4]


def fixture_module():
    path = ROOT / "desktop/tests/fixtures/reference21-v4-public.py"
    spec = importlib.util.spec_from_file_location("bounded_public_fixture_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic_complete_result():
    """仅供parent清理控制的完整门数据，不认证任务或模型质量。"""
    return {"stopped_code": None, "receipt_error_code": None, "records_error_code": None,
        "cleanup_error_codes": [], "summary": {"plan_complete": True,
        "dimensions": [{"dimension": axis, "cases": 15, "semantic_scenarios": 15,
            "false_facts": 0, "wrong_subjects": 0, "general_errors": 1, "meets_gate": True}
            for axis in ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")],
        "proof_delivery": {"delivered_positive_windows": 7, "frames": ["direct", "reported_request", "received_request"]},
        "known_raw_safety": {"raw_reviewed_windows": 15, "raw_false_fact": 0, "raw_wrong_person": 0,
            "unsafe_windows": 0, "without_final_review": 0}}}


class BoundedPublicFixtureTest(unittest.TestCase):
    def test_prepare_and_validate_use_formal_sources_without_budget_or_credential(self):
        module = fixture_module()

        def forbidden(*args, **kwargs):
            self.fail("来源准备和验证不得领取模型预算或读取凭据")

        helper = module.helpers()
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(module, "helpers", return_value=helper), \
                patch.object(helper, "read_credential", side_effect=forbidden):
            directory = Path(temporary).resolve() / "formal"
            frozen = module.prepare(directory=directory, absolute_start=datetime.now(timezone.utc), profile="bounded15")
            from notalone.memory_extraction.evaluation_bounded_sources import cleanup_bounded_sources, load_bounded_sources

            try:
                data = load_bounded_sources(frozen["formal_sources"])
                self.assertEqual(len(data.windows), 15)
                self.assertEqual(len(set(data.task_ids)), 15)
                self.assertEqual(frozen["fixed"]["request_limit"], 30)
                module.validate(frozen)
                for change in ("runtime_rule_set_sha256", "actual_windows", "formal_task_bindings"):
                    broken = deepcopy(frozen)
                    if change == "runtime_rule_set_sha256":
                        broken[change] = "f" * 64
                    elif change == "actual_windows":
                        broken[change][0]["messages"][0]["text"] += "改动"
                    else:
                        broken[change][0]["task_id"] = broken[change][1]["task_id"]
                    with self.subTest(change=change), self.assertRaises(ValueError):
                        module.validate(broken)
            finally:
                archive = directory / "source-close"
                archive.mkdir(mode=0o700)
                cleanup_bounded_sources(frozen["formal_sources"], archive_directory=archive)

    def test_owned_entry_closes_first_failed_positive_and_erases_formal_sources(self):
        from notalone.memory_extraction import evaluation_owned_process as owned
        from notalone.memory_extraction.evaluation_bounded_sources import cleanup_bounded_sources

        module = fixture_module()
        helper = module.helpers()
        real_launch = owned._launch_owned_public_worker

        def synthetic_launch(**arguments):
            # 只换测试子进程脚本，仍由生产launcher创建、握手、领取和回收进程组。
            arguments["script"] = Path(__file__).resolve()
            return real_launch(**arguments)

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}):
            directory = Path(temporary).resolve() / "formal"
            frozen = module.prepare(directory=directory, absolute_start=datetime.now(timezone.utc), profile="bounded15")
            freeze_path = directory / "freeze.json"
            freeze_sha = helper.file_digest(freeze_path)
            approval_path = directory / "synthetic-approval.json"
            helper.publish(approval_path, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": freeze_sha})
            try:
                with patch.object(owned, "_launch_owned_public_worker", side_effect=synthetic_launch):
                    finish = module.launch(freeze_path=freeze_path, expected_sha256=freeze_sha, approval_path=approval_path)
                self.assertEqual(finish["exit_code"], 0, finish)
                self.assertTrue(finish["worker_gone"])
                self.assertTrue(finish["closed"])
                self.assertFalse(finish["quality_certified"])
                self.assertEqual(finish["formal_lifecycle"]["status"], "unrun")
                details = helper.read_private(directory / "synthetic-claim-failure.json") if (directory / "synthetic-claim-failure.json").exists() else {}
                self.assertEqual(finish["stopped_code"], "bounded_runtime_positive_delivery_missing", details)
                self.assertEqual(finish["formal_source_closure"]["database_residual"], 0)
                self.assertTrue(all(count == 0 for count in finish["formal_source_closure"]["residual_counts"].values()))
                result = helper.read_private(directory / "result.json")
                self.assertEqual(result["receipt"]["budget"]["reserved_requests"], 1)
                self.assertEqual(result["summary"]["unrun"], 14)
                self.assertEqual(helper.read_private(directory / "synthetic-control.json"), {"requests": 1, "credentials_loaded": 1})
                archive = helper.read_private(Path(finish["formal_source_closure"]["archive_path"]))
                self.assertNotIn("synthetic-private-reasoning", json.dumps(archive))
                self.assertTrue((directory / "source-finish.json").is_file())
            finally:
                if not (directory / "source-finish.json").exists():
                    archive = directory / "failed-test-source-close"
                    archive.mkdir(mode=0o700)
                    cleanup_bounded_sources(frozen["formal_sources"], archive_directory=archive)

    def test_lifecycle_requires_all_fifteen_independent_axes_and_no_sealed_safety(self):
        module = fixture_module()
        finish = {"closed": True, "worker_gone": True, "exit_code": 0}
        completed = synthetic_complete_result()
        self.assertTrue(module._bounded_lifecycle_eligible(completed, finish))
        for fault in ("partial", "mixed_count", "raw_safety", "unfinished_full", "missing_frame", "technical_stop", "missing_axis", "invalid_frame_type", "invalid_axis_type"):
            broken = deepcopy(completed)
            summary = broken["summary"]
            if fault == "partial":
                summary["plan_complete"] = False
            elif fault == "mixed_count":
                summary["dimensions"][0]["cases"] = 7
            elif fault == "raw_safety":
                summary["known_raw_safety"]["raw_false_fact"] = 1
            elif fault == "unfinished_full":
                summary["known_raw_safety"]["without_final_review"] = 1
            elif fault == "missing_frame":
                summary["proof_delivery"]["frames"].remove("received_request")
            elif fault == "technical_stop":
                broken["stopped_code"] = "offline_hard_stop"
            elif fault == "invalid_frame_type":
                summary["proof_delivery"]["frames"] = None
            elif fault == "invalid_axis_type":
                summary["dimensions"][0]["dimension"] = {}
            else:
                summary["dimensions"].pop()
            with self.subTest(fault=fault):
                self.assertFalse(module._bounded_lifecycle_eligible(broken, finish))

    def test_lifecycle_failure_is_recorded_before_formal_source_cleanup(self):
        from notalone.memory_extraction import evaluation_owned_process as owned
        from notalone.memory_extraction import evaluation_bounded_sources as sources
        module = fixture_module()
        helper = module.helpers()

        def forbidden(*args, **kwargs):
            self.fail("parent清理控制不得创建模型预算或读取凭据")

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                patch.object(module, "helpers", return_value=helper), \
                patch.object(EvaluationBudget, "create", side_effect=forbidden), \
                patch.object(helper, "read_credential", side_effect=forbidden):
            directory = Path(temporary).resolve() / "formal"
            frozen = module.prepare(directory=directory, absolute_start=datetime.now(timezone.utc), profile="bounded15")
            freeze_path, approval_path = directory / "freeze.json", directory / "synthetic-approval.json"
            expected = helper.file_digest(freeze_path)
            helper.publish(approval_path, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected})
            helper.publish(directory / "result.json", synthetic_complete_result())
            try:
                with patch.object(owned, "_launch_owned_public_worker", return_value={"closed": True,
                        "worker_gone": True, "exit_code": 0, "quality_certified": False}), \
                        patch.object(sources, "verify_bounded_lifecycle", side_effect=RuntimeError("合成生命周期中断")) as verify:
                    finish = module.launch(freeze_path=freeze_path, expected_sha256=expected, approval_path=approval_path)
                verify.assert_called_once()
                self.assertEqual(finish["formal_lifecycle"]["status"], "failed")
                self.assertFalse(finish["quality_certified"])
                self.assertEqual(finish["formal_source_closure"]["database_residual"], 0)
                self.assertEqual(helper.read_private(directory / "lifecycle-result.json")["lifecycle"], finish["formal_lifecycle"])
                self.assertTrue(Path(finish["formal_source_closure"]["archive_path"]).is_file())
            finally:
                if not (directory / "source-finish.json").exists():
                    archive = directory / "failed-test-source-close"
                    archive.mkdir(mode=0o700)
                    sources.cleanup_bounded_sources(frozen["formal_sources"], archive_directory=archive)

    def test_partial_result_or_lifecycle_receipt_failure_still_archives_and_cleans_sources(self):
        from notalone.memory_extraction import evaluation_owned_process as owned
        from notalone.memory_extraction import evaluation_bounded_sources as sources
        module = fixture_module()
        helper = module.helpers()
        original_publish = helper.publish
        for fault in ("partial_result", "receipt_failure"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary, \
                    patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}), \
                    patch.object(module, "helpers", return_value=helper):
                directory = Path(temporary).resolve() / "formal"
                frozen = module.prepare(directory=directory, absolute_start=datetime.now(timezone.utc), profile="bounded15")
                freeze_path, approval_path = directory / "freeze.json", directory / "synthetic-approval.json"
                expected = helper.file_digest(freeze_path)
                helper.publish(approval_path, {"user_authorized": True, "run_id": frozen["run_id"], "freeze_sha256": expected})
                if fault == "partial_result":
                    descriptor = os.open(directory / "result.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "wb") as output:
                        output.write(b'{"summary":')
                else:
                    helper.publish(directory / "result.json", synthetic_complete_result())

                def publish(path, value):
                    if fault == "receipt_failure" and path.name == "lifecycle-result.json":
                        raise OSError("合成生命周期收据写入失败")
                    return original_publish(path, value)

                try:
                    with patch.object(owned, "_launch_owned_public_worker", return_value={"closed": True,
                            "worker_gone": True, "exit_code": 0, "quality_certified": False}), \
                            patch.object(sources, "verify_bounded_lifecycle", return_value={"status": "passed"}), \
                            patch.object(helper, "publish", side_effect=publish):
                        finish = module.launch(freeze_path=freeze_path, expected_sha256=expected, approval_path=approval_path)
                    self.assertFalse(finish["quality_certified"])
                    self.assertEqual(finish["formal_source_closure"]["database_residual"], 0)
                    self.assertTrue(Path(finish["formal_source_closure"]["archive_path"]).is_file())
                    if fault == "partial_result":
                        self.assertEqual(finish["formal_lifecycle"]["status"], "failed")
                        self.assertEqual((directory / "result.json").read_bytes(), b'{"summary":')
                    else:
                        self.assertEqual(finish["lifecycle_receipt_error"], "OSError")
                        self.assertEqual(finish["formal_lifecycle"]["status"], "unknown")
                finally:
                    if not (directory / "source-finish.json").exists():
                        archive = directory / "failed-test-source-close"
                        archive.mkdir(mode=0o700)
                        sources.cleanup_bounded_sources(frozen["formal_sources"], archive_directory=archive)


def synthetic_owned_worker(freeze_path: Path, expected_sha256: str, approval_path: Path) -> None:
    """独占子进程仅使用真实SDK的MockTransport与本地合成凭据。"""
    from copy import deepcopy
    import httpx

    module = fixture_module()
    helper = module.helpers()
    original_claim = module.verify_claim
    directory = freeze_path.parent
    synthetic_home = directory / "synthetic-home"
    synthetic_home.mkdir(mode=0o700)
    counts = {"requests": 0, "credentials_loaded": 0}

    def forbidden(*args, **kwargs):
        raise AssertionError("合成纵切不得读取真实凭据或发送真实HTTP")

    def credential():
        counts["credentials_loaded"] += 1
        return "synthetic-only"

    def verify_claim(frozen):
        try:
            original_claim(frozen)
        except Exception as error:
            from notalone.memory_extraction.evaluation_owned_process import _verify_bounded_claim
            manifest = helper.read_private(directory / "evaluation/manifest.json")
            from notalone.memory_extraction.evaluation_bounded_sources import load_bounded_sources
            data = load_bounded_sources(frozen["formal_sources"])
            try:
                _verify_bounded_claim(frozen, manifest["frozen_config"], helper, data.windows)
            except Exception as inner:
                helper.publish(directory / "synthetic-claim-failure.json", {"error": str(error), "bounded_error": str(inner)})
            else:
                helper.publish(directory / "synthetic-claim-failure.json", {"error": str(error)})
            raise

    def respond(request):
        counts["requests"] += 1
        body = json.loads(request.content)
        name = body["tools"][0]["function"]["name"]
        if name != "GroundedMemoryLabels" or counts["requests"] != 1:
            raise AssertionError("首窗空结果应停止，不得执行V或后继窗")
        if body["tools"][0]["function"]["parameters"]["properties"]["units"]["required"] != ["0:0"]:
            raise AssertionError("合成输出必须对应当前schema的全部原文位置")
        labels = {"kind": "not_memory", "subject": "contact", "topic": "other", "dependency": None,
                  "unresolved": False, "confidence": 0.95, "sensitivity": "none"}
        return httpx.Response(200, request=request, json={"id": "synthetic-first-empty", "object": "chat.completion",
            "created": 1, "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls",
            "message": {"role": "assistant", "content": "", "reasoning_content": "synthetic-private-reasoning",
                "tool_calls": [{"id": "synthetic-e", "type": "function", "function": {"name": name,
                    "arguments": json.dumps({"units": {"0:0": labels}})}}]}}]})

    class EmptyReview:
        def review(self, phase, view):
            if phase == "raw":
                return {"reviewer": "合成RAW控制", "case_id": view["case_id"], "reference_sha256": view["reference_sha256"],
                    "raw_evidence_sha256": view["raw_evidence_sha256"], "e_rows": [],
                    "claims": [{"claim_id": row["id"], "groups": []} for row in view["reference_case"]["claims"]],
                    "window_checks": {"inclusion": "fail", "forbidden_meanings": "pass"}}
            review = deepcopy(view["sealed_raw_review"])
            review.pop("raw_evidence_sha256")
            review.update(evidence_sha256=view["packet"]["evidence_sha256"], run_status="empty", v_rows=[],
                axis_reviews={axis: {"status": "fail", "basis": "合成到家必需主张遗漏，逐维不授予通过"}
                    for axis in ("subject", "time", "truth_intent", "paraphrase", "reference", "media", "reported")})
            review["window_checks"]["lineage"] = "pass"
            return review

    with patch.object(Path, "home", return_value=synthetic_home), patch.object(module, "helpers", return_value=helper), \
            patch.object(module, "verify_claim", side_effect=verify_claim), \
            patch.object(helper, "read_credential", side_effect=forbidden), \
            patch.object(httpx.HTTPTransport, "handle_request", side_effect=forbidden), \
            patch.object(httpx.AsyncHTTPTransport, "handle_async_request", side_effect=forbidden):
        module.worker(freeze_path=freeze_path, expected_sha256=expected_sha256, approval=helper.read_private(approval_path),
            synthetic_transport=httpx.MockTransport(respond), credential_loader=credential, bridge=EmptyReview())
    helper.publish(directory / "synthetic-control.json", counts)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "worker":
        if sys.stdin.buffer.readline(7) != b"start\n":
            raise AssertionError("必须由自有launcher握手")
        synthetic_owned_worker(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    else:
        unittest.main()
