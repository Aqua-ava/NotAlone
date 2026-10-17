"""评测审核先封存 raw 视图，再揭示 V／程序层；不认证盲标或模型质量。"""

from __future__ import annotations

import json
from typing import Any, Callable

from .evaluation_http_budget import EvaluationBudgetAbort
from .evaluation_extraction import EvaluationExtractionMode, extraction_tool_name
from .evaluation_provider_contract import (
    validate_evaluation_policy, MIXED_PLAN, MIXED_REQUEST_VERSION, mixed_phase_policy,
    FULL140_E2_PLAN, PHASE_SPLIT_PLANS, REFERENCE21_PLANS, PUBLIC_QUALITY_PLANS, UNIQUENESS_PLAN,
    validate_extraction_prompt_profile,
)
from .evaluation_records import canonical_sha256
from .evaluation_reference import (
    public_window_projection, validate_full_public_reference, validate_public_reference,
)
from .evaluation_review import prepare_case_review, score_case_review
from .verification import SourceVerificationMode
from .source_proof import parse_proposal


_E_TOOL = "MemoryExtractionOutput"
_V_TOOL = "SourceVerificationOutput"
_RAW_CHECKS = ("raw_meaning", "coherence", "branch", "source", "time")
_V_FIELDS = {"candidate_index", "verdict", "issues", "evidence"}


def _copy(value: dict) -> dict:
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _exact(value: dict, fields: set[str]) -> None:
    if not isinstance(value, dict) or set(value) != fields:
        raise EvaluationBudgetAbort("phased_review_fields_invalid")


def _save(
    persist: Callable[[dict], dict], payload: dict, position: int, case_name: str,
) -> dict:
    receipt = _copy(persist(_copy(payload)))
    digest = canonical_sha256(payload)
    if (receipt.get("kind") != "semantic_audit" or receipt.get("purpose") != "case"
            or type(receipt.get("case_position")) is not int
            or receipt["case_position"] != position or receipt.get("case_name") != case_name
            or type(receipt.get("event_sequence")) is not int or receipt["event_sequence"] < 1
            or receipt.get("removed_paths") != [] or receipt.get("payload") != payload
            or receipt.get("payload_sha256") != digest
            or canonical_sha256(receipt["payload"]) != digest):
        raise EvaluationBudgetAbort("phased_audit_receipt_invalid")
    return receipt


def _validate_raw(reference: dict, view: dict, review: dict) -> None:
    _exact(review, {"reviewer", "case_id", "reference_sha256", "raw_evidence_sha256",
                    "e_rows", "claims", "window_checks"})
    if (review["case_id"] != view["case_id"]
            or review["reference_sha256"] != view["reference_sha256"]
            or review["raw_evidence_sha256"] != view["raw_evidence_sha256"]):
        raise EvaluationBudgetAbort("phased_raw_binding_changed")
    _exact(review["window_checks"], {"inclusion", "forbidden_meanings"})
    for row in review["e_rows"]:
        _exact(row, {"raw_index", "payload_sha256", "fields", "meaning", "inclusion",
                     "safety", "classification", "basis"})
    for claim in review["claims"]:
        for group in claim["groups"]:
            _exact(group, {"raw_indices", "variant_id", *_RAW_CHECKS})
    # unknown 只作 raw 字段校验的有界占位；不伪造或揭示实际 V／程序结果。
    packet = prepare_case_review(reference, view["case_id"], {
        "run_status": "unknown", "extraction": [item["payload"] for item in view["extraction"]],
        "verification_inputs": [], "verification": [], "final_facts": [], "original_result": {},
    })
    completed = _copy(review)
    completed.pop("raw_evidence_sha256")
    completed.update(run_status="unknown", evidence_sha256=packet["evidence_sha256"], v_rows=[])
    for row in completed["e_rows"]:
        row["lineage"] = {"v_input_indices": [], "final_indices": [], "status": "unresolved"}
    for claim in completed["claims"]:
        for group in claim["groups"]:
            group.update(final_indices=[], lineage="unresolved", destination="unresolved")
    completed["window_checks"]["lineage"] = "unresolved"
    score_case_review(packet, completed)


def _check_sealed_raw(raw: dict, full: dict) -> None:
    keys = ("case_id", "reference_sha256", "e_rows", "claims", "window_checks")
    original = _copy({key: raw[key] for key in keys})
    projected = _copy({key: full[key] for key in keys})
    for row in projected["e_rows"]:
        row.pop("lineage")
    for claim in projected["claims"]:
        for group in claim["groups"]:
            for key in ("final_indices", "lineage", "destination"):
                group.pop(key)
    projected["window_checks"].pop("lineage")
    if projected != original:
        raise EvaluationBudgetAbort("phased_sealed_raw_changed")


def _decision(report: dict, review: dict, reference_case: dict) -> tuple[str, str]:
    safety = report["safety"]
    if safety["raw_wrong_person"] or safety["wrong_person"]:
        return "safety_error", "wrong_subject"
    if safety["raw_false_fact"] or safety["false_fact"]:
        return "safety_error", "false_fact"
    if safety["bad_auto"] or safety["ambiguous_auto"]:
        return "safety_error", "contract_mismatch"
    if (report["review_unresolved"] or report["unmapped_v_inputs"]
            or report["unmapped_final_facts"] or safety["unresolved_auto"] or safety["unmapped_auto"]):
        return "unknown", "audit_unresolved"
    if report["required"]["full"] != report["required"]["total"]:
        return "general_error", "coverage_miss"
    checks = list(review["window_checks"].values())
    for row in review["e_rows"]:
        checks.extend((*row["fields"].values(), row["meaning"], row["inclusion"], row["lineage"]["status"]))
    for row in review["v_rows"]:
        checks.extend((*row["fields"].values(), row["semantic"], row["lineage"]))
    for claim in review["claims"]:
        for group in claim["groups"]:
            checks.extend(group[key] for key in (*_RAW_CHECKS, "lineage", "destination"))
    if ("fail" in checks or report["classifications"]["extra"] or report["classifications"]["excluded"]
            or (reference_case["inclusion"] == "none" and not report["none_correct"])):
        return "general_error", "contract_mismatch"
    return "safe", "supported"


def _arguments(outputs: list[dict], tool: str, key: str, *, e_tool: str = _E_TOOL) -> Any:
    for output in outputs:
        calls = output["tool_calls"]
        if (not isinstance(calls, list) or len(calls) != 1
                or calls[0].get("name") not in {e_tool, _V_TOOL}):
            raise EvaluationBudgetAbort("phased_adapter_output_unreliable")
        expected_key = ("results" if calls[0]["name"] == _V_TOOL else
                        "units" if e_tool in {
                            "GroundedMemoryLabels", "GroundedMemoryLabelsV3", "GroundedMemoryLabelsV4",
                        } else "facts")
        _exact(calls[0]["args"], {expected_key})
    matches = [call["args"][key] for output in outputs for call in output["tool_calls"]
               if call["name"] == tool]
    if len(matches) != 1 or not isinstance(matches[0], dict if key == "units" else list):
        raise EvaluationBudgetAbort("phased_adapter_output_unreliable")
    return matches[0]


def _verification_inputs(requests: list[dict], *, verification_tool_choice: str = "forced",
                         extraction_tool_choice: str = "forced", e_tool: str = _E_TOOL) -> list[dict]:
    matches = []
    bodies = []
    for request in requests:
        body = request["body"]
        if not isinstance(body["tools"], list) or len(body["tools"]) != 1:
            raise EvaluationBudgetAbort("phased_verification_request_unreliable")
        tool = body["tools"][0]
        name = tool["function"]["name"]
        omitted = (name == _V_TOOL and verification_tool_choice == "omitted"
                   or name == e_tool and extraction_tool_choice == "omitted")
        if (tool.get("type") != "function" or name not in {e_tool, _V_TOOL}
                or (omitted and "tool_choice" in body)
                or (not omitted and body.get("tool_choice") != {
                    "type": "function", "function": {"name": name}})):
            raise EvaluationBudgetAbort("phased_verification_request_unreliable")
        if name != _V_TOOL:
            continue
        user = [message["content"] for message in body["messages"] if message["role"] == "user"]
        if len(user) != 1:
            raise EvaluationBudgetAbort("phased_verification_request_unreliable")
        matches.append(json.loads(user[0])["candidates"])
        bodies.append(canonical_sha256(body))
    if not matches or any(value != bodies[0] for value in bodies):
        raise EvaluationBudgetAbort("phased_verification_request_unreliable")
    return matches[0]


def _verification_projection(results: list[dict], mode: SourceVerificationMode) -> list[dict]:
    """原四槽评分不掺程序判定；完整proof仍在已保存输出与完整审核视图。"""
    projected = []
    for result in results:
        if (not isinstance(result, dict) or not (
            set(result) == _V_FIELDS or mode is SourceVerificationMode.NULLABLE_PROOF_V1
            and set(result) == _V_FIELDS | {"proof"}
        )):
            raise EvaluationBudgetAbort("phased_verification_fields_invalid")
        if "proof" in result:
            parse_proposal(result["proof"])
        projected.append(_copy({key: result[key] for key in _V_FIELDS}))
    return projected


class PhasedEvaluationAudit:
    """两个显式审核回调及当前case保存能力；没有文件、模型或业务入口。"""

    def __init__(
        self, *, reference: dict, expected_reference_sha256: str,
        annotation_sha256: str, criteria_sha256: str,
        raw_reviewer: Callable[[dict], dict], full_reviewer: Callable[[dict], dict],
        case_positions: tuple[int, ...] | None = None,
        case_set: str = "reference21",
        verification_mode: SourceVerificationMode | str = SourceVerificationMode.LEGACY_V4,
        verification_tool_choice: str = "forced",
        extraction_tool_choice: str = "forced",
        extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
        reference_version: str = "legacy-v1",
        execution_plan: str = "original",
        extraction_prompt_profile: str = "default",
    ):
        if type(execution_plan) is not str or execution_plan not in {"original", *PHASE_SPLIT_PLANS}:
            raise ValueError("审核执行身份非法。")
        self._execution_plan = execution_plan
        e2 = execution_plan == FULL140_E2_PLAN
        mixed = execution_plan in PHASE_SPLIT_PLANS
        reference21_v4 = execution_plan in REFERENCE21_PLANS
        public_quality = execution_plan in PUBLIC_QUALITY_PLANS
        try:
            validate_extraction_prompt_profile(execution_plan, extraction_prompt_profile)
        except EvaluationBudgetAbort:
            raise ValueError("审核提取提示profile与身份不符。") from None
        self._extraction_prompt_profile = extraction_prompt_profile
        self._verification_mode = SourceVerificationMode(verification_mode)
        self._extraction_mode = EvaluationExtractionMode(extraction_mode)
        validate_evaluation_policy(verification_tool_choice)
        if verification_tool_choice == "omitted" and self._verification_mode is not SourceVerificationMode.NULLABLE_PROOF_V1:
            raise ValueError("省略V工具选择只用于可空证明评测。")
        self._verification_tool_choice = verification_tool_choice
        if extraction_tool_choice not in {"forced", "omitted"}:
            raise ValueError("提取工具选择策略非法。")
        self._extraction_tool_choice = extraction_tool_choice
        if (type(case_set) is not str or case_set not in {"reference21", "full140"}
                or (case_set == "full140" and case_positions is not None)):
            raise ValueError("审核只接受原21或固定完整140，不允许完整集合缩减。")
        if type(reference_version) is not str or reference_version not in {
            "legacy-v1", "source-fidelity-v2",
        }:
            raise ValueError("审核参考版本须为已注册封闭值。")
        if (reference_version == "source-fidelity-v2"
                or self._extraction_mode is EvaluationExtractionMode.GROUNDED_V4):
            if (reference_version != "source-fidelity-v2"
                    or self._extraction_mode is not (EvaluationExtractionMode.GROUNDED_V2 if e2 else EvaluationExtractionMode.GROUNDED_V4)
                    or case_set != ("reference21" if reference21_v4 else "full140") or case_positions is not None
                    or self._verification_mode is not (SourceVerificationMode.LEGACY_V4 if public_quality or e2 else SourceVerificationMode.NULLABLE_PROOF_V1)
                    or extraction_tool_choice != "omitted" or verification_tool_choice != ("forced" if mixed else "omitted")):
                raise ValueError("来源保真v2审核须匹配已注册的完整140协议。")
        if mixed and (reference_version != "source-fidelity-v2" or self._extraction_mode.value != ("grounded-v2" if e2 else "grounded-v4")):
            raise ValueError("混合策略仅用于完整140的来源保真v2。")
        self._reference_version = reference_version
        validation = (validate_full_public_reference if case_set == "full140"
                      else validate_public_reference)(
            reference, expected_reference_sha256=expected_reference_sha256,
            annotation_sha256=annotation_sha256, reference_version=reference_version,
        )
        if reference_version == "source-fidelity-v2" and validation.get("execution_ready") is not True:
            raise ValueError("来源保真v2参考尚未执行就绪。")
        self._reference = _copy(reference)
        if case_set == "full140":
            positions = validation["case_positions"]
        else:
            positions = (tuple(range(len(self._reference["windows"])))
                         if case_positions is None else case_positions)
        if (type(positions) is not tuple or not positions
                or any(type(position) is not int
                       or not 0 <= position < len(self._reference["windows"])
                       for position in positions)
                or len(set(positions)) != len(positions)):
            raise ValueError("审核位置须唯一且对应完整公开参考。")
        if (not isinstance(criteria_sha256, str) or len(criteria_sha256) != 64
                or any(char not in "0123456789abcdef" for char in criteria_sha256)
                or not callable(raw_reviewer) or not callable(full_reviewer)):
            raise ValueError("两阶段审核需要明确摘要与两个审核回调。")
        self._reference_sha256 = expected_reference_sha256
        self._case_positions = positions
        self._case_set = case_set
        self._criteria_sha256 = criteria_sha256
        self._raw_reviewer = raw_reviewer
        self._full_reviewer = full_reviewer

    @property
    def execution_plan(self) -> str:
        return self._execution_plan

    @property
    def reference_version(self) -> str:
        """冻结参考版本须与实际case bundle一致。"""
        return self._reference_version

    @property
    def criteria_sha256(self) -> str:
        """独立的criteria文件字节摘要，不与规范reference摘要混用。"""
        return self._criteria_sha256

    @property
    def case_positions(self) -> tuple[int, ...]:
        """本stage局部位置对应的原Gold位置；不重排或缩减参考。"""
        return self._case_positions

    @property
    def case_set(self) -> str:
        """只标识两个固定公开集合，不允许调用方注入cases。"""
        return self._case_set

    @property
    def reference_sha256(self) -> str:
        """完整装配对象摘要；选定case的原21投影另保留原摘要。"""
        return self._reference_sha256

    @property
    def verification_mode(self) -> str:
        """原评分四槽固定，实际V协议须与受限入口显式一致。"""
        return self._verification_mode.value

    @property
    def verification_tool_choice(self) -> str:
        """审核与HTTP入口必须显式使用同一V请求策略。"""
        return self._verification_tool_choice

    @property
    def extraction_tool_choice(self) -> str:
        """提取请求的显式绑定策略；返回仍按唯一具名工具核对。"""
        return self._extraction_tool_choice

    @property
    def extraction_mode(self) -> str:
        """模型标签与程序十四槽须使用显式同版本审核。"""
        return self._extraction_mode.value

    @property
    def extraction_prompt_profile(self) -> str:
        return self._extraction_prompt_profile

    def __call__(self, bundle: dict) -> dict:
        try:
            return self._run(bundle)
        except EvaluationBudgetAbort:
            raise
        except Exception:
            raise EvaluationBudgetAbort("phased_audit_unreliable") from None

    def _run(self, bundle: dict) -> dict:
        if (bundle.get("execution_plan", "original") != self.execution_plan
                or self.execution_plan in PHASE_SPLIT_PLANS and (
                    bundle.get("phase_request_version") != MIXED_REQUEST_VERSION
                    or bundle.get("phase_request_policy") != mixed_phase_policy())
                or self.execution_plan not in PHASE_SPLIT_PLANS and (
                    "phase_request_version" in bundle or "phase_request_policy" in bundle)):
            raise EvaluationBudgetAbort("phased_execution_plan_changed")
        if bundle.get("reference_version", "legacy-v1") != self.reference_version:
            raise EvaluationBudgetAbort("phased_reference_version_changed")
        if bundle.get("extraction_mode", "legacy-e14") != self.extraction_mode:
            raise EvaluationBudgetAbort("phased_extraction_mode_changed")
        if (bundle.get("extraction_prompt_profile", "default") != self.extraction_prompt_profile
                or self.execution_plan != UNIQUENESS_PLAN and "extraction_prompt_profile" in bundle):
            raise EvaluationBudgetAbort("phased_extraction_prompt_profile_changed")
        if bundle.get("verification_mode", "legacy-v4") != self.verification_mode:
            raise EvaluationBudgetAbort("phased_verification_mode_changed")
        if bundle.get("verification_tool_choice", "forced") != self.verification_tool_choice:
            raise EvaluationBudgetAbort("phased_tool_choice_changed")
        if bundle.get("extraction_tool_choice", "forced") != self.extraction_tool_choice:
            raise EvaluationBudgetAbort("phased_extraction_tool_choice_changed")
        # 回调只编辑审核结果；已保存case证据在本次调用内固定。
        evidence_bundle = _copy({key: bundle[key] for key in (
            "case_position", "case_name", "window", "gold_reference", "adapter_outputs",
            "provider_requests", "original_result",
        )})
        evidence_bundle["verification_program"] = _copy({
            "items": bundle.get("verification_program", []),
        })["items"]
        evidence_bundle["extraction_program"] = _copy({
            "items": bundle.get("extraction_program", []),
        })["items"]
        bundle = {**evidence_bundle, "persist_audit": bundle["persist_audit"]}
        position = bundle["case_position"]
        if type(position) is not int or not 0 <= position < len(self._case_positions):
            raise EvaluationBudgetAbort("phased_case_position_invalid")
        reference_position = self._case_positions[position]
        reference = (self._reference["provenance"]["parent21"]["reference"]
                     if self._case_set == "full140" and reference_position < 21
                     else self._reference)
        reference_sha = (canonical_sha256(reference) if reference is not self._reference
                         else self._reference_sha256)
        reference_case = reference["windows"][reference_position]
        if (bundle["case_name"] != reference_case["case_name"]
                or canonical_sha256(public_window_projection(bundle["window"])) !=
                reference_case["input_sha256"]
                or bundle["gold_reference"]["criteria_sha256"] != self._criteria_sha256):
            raise EvaluationBudgetAbort("phased_case_binding_changed")
        e_tool = extraction_tool_name(self._extraction_mode)
        extraction_protocol = None
        if self._extraction_mode.is_grounded:
            labels = _arguments(list(bundle["adapter_outputs"]), e_tool, "units", e_tool=e_tool)
            programs = bundle["extraction_program"]
            if (not labels or not isinstance(programs, list) or len(programs) != 1
                    or not isinstance(programs[0], dict)
                    or set(programs[0]) != {"extraction_mode", "status", "facts"}
                    or programs[0]["extraction_mode"] != self.extraction_mode
                    or programs[0]["status"] != "compiled"
                    or not isinstance(programs[0]["facts"], list)):
                raise EvaluationBudgetAbort("phased_grounded_compilation_unreliable")
            extraction = programs[0]["facts"]
            extraction_protocol = {
                "extraction_mode": self.extraction_mode, "e14_origin": "grounded_compiler",
                "model_labels": {"units": labels}, "program_result": programs[0],
            }
        else:
            if bundle["extraction_program"]:
                raise EvaluationBudgetAbort("phased_legacy_compilation_unexpected")
            extraction = _arguments(list(bundle["adapter_outputs"]), _E_TOOL, "facts")
        raw_view = _copy({
            "case_id": reference_case["id"], "case_position": position,
            "case_name": reference_case["case_name"], "window": bundle["window"],
            "reference_case": reference_case, "common_rules": reference["common_rules"],
            "e_fields": reference["e_fields"], "reference_sha256": reference_sha,
            "extraction": [{"index": index, "payload": fact, "payload_sha256": canonical_sha256(fact)}
                           for index, fact in enumerate(extraction)],
            **({"extraction_protocol": extraction_protocol} if extraction_protocol is not None else {}),
        })
        raw_view["raw_evidence_sha256"] = canonical_sha256(raw_view)
        raw_review = _copy(self._raw_reviewer(_copy(raw_view)))
        _validate_raw(reference, raw_view, raw_review)
        protocol_fields = ({"extraction_protocol": extraction_protocol}
                           if extraction_protocol is not None else {})
        receipt = _save(bundle["persist_audit"], {"phase": "raw", "review": raw_review, **protocol_fields},
                        position, reference_case["case_name"])
        if not extraction and (
            any(output["tool_calls"][0]["name"] == _V_TOOL for output in bundle["adapter_outputs"])
            or any(request["body"]["tools"][0]["function"]["name"] == _V_TOOL
                   for request in bundle["provider_requests"])
        ):
            raise EvaluationBudgetAbort("phased_empty_extraction_has_verification")
        verification = (_arguments(list(bundle["adapter_outputs"]), _V_TOOL, "results", e_tool=e_tool)
                        if extraction else [])
        evidence = {
            "run_status": "completed" if extraction else "empty", "extraction": extraction,
            "verification_inputs": _verification_inputs(
                list(bundle["provider_requests"]), verification_tool_choice=self.verification_tool_choice,
                extraction_tool_choice=self.extraction_tool_choice,
                e_tool=e_tool,
            ) if extraction else [],
            "verification": _verification_projection(verification, self._verification_mode),
            "final_facts": bundle["original_result"]["facts"], "original_result": bundle["original_result"],
        }
        packet = prepare_case_review(reference, reference_case["id"], _copy(evidence))
        receipt_ref = {key: receipt[key] for key in (
            "case_position", "case_name", "kind", "purpose", "event_sequence", "payload_sha256",
        )}
        full_view = {"packet": packet, "sealed_raw_review": raw_review,
                     "raw_receipt": receipt_ref, **protocol_fields}
        protocol = None
        if self._verification_mode is SourceVerificationMode.NULLABLE_PROOF_V1:
            protocol = {
                "verification_mode": self.verification_mode,
                "model_results": verification,
                "program_results": bundle["verification_program"],
                "final_dimension_evidence": [{
                    "final_index": index, "dimension_evidence": fact.get("dimension_evidence"),
                } for index, fact in enumerate(bundle["original_result"]["facts"])],
            }
            full_view["verification_protocol"] = protocol
        full_review = _copy(self._full_reviewer(_copy(full_view)))
        _check_sealed_raw(raw_review, full_review)
        report = score_case_review(packet, full_review)
        final_receipt = _save(bundle["persist_audit"], {
            "phase": "final", "review": full_review, "report": report, "raw_receipt": receipt_ref,
            **({"verification_protocol": protocol} if protocol is not None else {}),
            **protocol_fields,
        }, position, reference_case["case_name"])
        if final_receipt["event_sequence"] <= receipt["event_sequence"]:
            raise EvaluationBudgetAbort("phased_audit_receipt_order_invalid")
        decision, reason = _decision(report, full_review, reference_case)
        return {"case_position": position, "decision": decision, "reason_code": reason,
                "criteria_sha256": self._criteria_sha256}
