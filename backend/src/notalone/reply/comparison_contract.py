"""受控分层安装与回复对照的证据合同；生产校验与评测共用。

只含被生产 `reply/quality.py` 使用的判定，评测包（`notalone.experiments`）
反向 import 本模块，避免生产源码依赖评测/实验包。
"""

from __future__ import annotations

from copy import deepcopy
from uuid import UUID

from notalone.memory.organization_quality import content_digest


def canonical_input(input_package: dict) -> dict:
    """只移除运行身份；联系人、确认回执、完整请求和L1版本参与摘要。"""
    value = deepcopy(input_package)
    for target in (value, value.get("request", {})):
        for key in ("session_id", "assistant_session_id", "request_key", "idempotency_key"):
            target.pop(key, None)
    return value


def _candidate_material(output: dict, mapping: list[dict]) -> dict:
    references = {}
    for item in mapping:
        key = (item["original_memory_id"], item["original_revision"])
        target = (item["installed_memory_id"], item["installed_revision"])
        if key in references or target in references.values():
            raise ValueError("安装引用映射须逐项唯一。")
        for identifier in (key[0], target[0]):
            UUID(identifier)
        if any(type(revision) is not int or revision < 1 for revision in (key[1], target[1])):
            raise ValueError("安装引用revision无效。")
        references[key] = target
    used = set()

    def remap(value):
        if isinstance(value, list):
            return [remap(item) for item in value]
        if isinstance(value, dict):
            if "memory_id" in value:
                key = (value["memory_id"], value["revision"])
                if set(value) != {"memory_id", "revision"} or key not in references:
                    raise ValueError("获审输出引用缺少明确原版本到安装版本映射。")
                used.add(key)
                target = references[key]
                return {"memory_id": target[0], "revision": target[1]}
            return {key: remap(item) for key, item in value.items()}
        return value

    scenarios = [{key: item[key] for key in ("title", "hint", "paragraphs")}
                 for item in output["l2"]["scenarios"]]
    material = remap({"scenarios": scenarios, "profile": output["l3"]["entries"]})
    if used != set(references) or not used:
        raise ValueError("安装引用映射必须完整且没有额外条目。")
    material["scenarios"].sort(key=content_digest)
    return material


def _installed_candidate_fields(value):
    """真实writer补入来源类型和时间；候选等价比较只投影其原引用字段。"""
    if isinstance(value, list):
        return [_installed_candidate_fields(item) for item in value]
    if isinstance(value, dict):
        if "memory_id" in value:
            if set(value) - {"memory_id", "revision", "provenance_kind", "timing"}:
                raise ValueError("安装引用出现未知派生字段。")
            return {key: value[key] for key in ("memory_id", "revision")}
        return {key: _installed_candidate_fields(item) for key, item in value.items()}
    return value


def validate_installation_binding(binding: dict, organization_output_sha256: str, review: dict) -> str:
    """独立静态重算原完整候选、原到实引用和安装正文；不信摘要形状。"""
    if (not isinstance(binding, dict) or binding.get("schema_version") != "controlled-layered-installation-v1"
            or binding.get("expected_scopes") not in (["contact"], ["owner"])
            or (review or {}).get("decision") != "approved"
            or (review or {}).get("reviewer_kind") not in {"agent", "human"}):
        raise ValueError("每个受控C候选须明确一侧范围和支持审阅。")
    original = binding["original_output"]
    if (content_digest(original) != organization_output_sha256
            or original.get("l2_verification") is not True or original.get("l3_verification") is not True):
        raise ValueError("原完整获审整理输出已变化或未通过核验。")
    expected = binding["expected_scopes"]
    if set(binding["installed"]) != set(expected):
        raise ValueError("安装范围与冻结候选不一致。")
    installed = binding["installed"][expected[0]]
    if any(type(installed.get(key)) is not int or installed[key] < 0
           for key in ("settings_generation", "organization_generation")):
        raise ValueError("安装世代必须为明确非负整数。")
    UUID(installed["scope"]["owner_id"])
    if expected == ["contact"]:
        UUID(installed["scope"]["contact_id"])
    elif installed["scope"].get("contact_id") is not None:
        raise ValueError("本人安装不能绑定联系人scope。")
    profile, scenarios = installed["profile_entries"], installed["scenarios"]
    if (installed["profile_sha256"] != content_digest(profile)
            or not installed["profile_version_id"] or not scenarios
            or len({item["scenario_id"] for item in scenarios}) != len(scenarios)
            or len({item["version_id"] for item in scenarios}) != len(scenarios)):
        raise ValueError("安装的profile或scenario版本不完整。")
    UUID(installed["profile_version_id"])
    for item in scenarios:
        UUID(item["scenario_id"])
        UUID(item["version_id"])
        if item["body_sha256"] != content_digest({key: item[key] for key in ("title", "hint", "paragraphs")}):
            raise ValueError("安装主题正文摘要不一致。")
    actual = {"profile": profile, "scenarios": sorted(
        ({key: item[key] for key in ("title", "hint", "paragraphs")} for item in scenarios), key=content_digest)}
    actual = _installed_candidate_fields(actual)
    actual["scenarios"].sort(key=content_digest)
    if actual != _candidate_material(original, binding["reference_mapping"]):
        raise ValueError("实际安装正文不等于原获审候选经明确引用映射后的正文。")
    return content_digest(binding)


def actual_evidence_material_receipt(evidence: dict) -> dict:
    return {kind: {"context": evidence.get(context), "scenario_reads": evidence.get(reads, [])}
            for kind, context, reads in (("contact", "layered_context", "layered_scenario_reads"),
                                         ("owner", "owner_layered_context", "owner_layered_scenario_reads"))}


def validate_persisted_installation(binding: dict, evidence: dict, arm: str) -> dict:
    """持久依据只能使用冻结版本、对应profile条目及主题段落。"""
    actual = actual_evidence_material_receipt(evidence)
    for kind, receipt in actual.items():
        context = receipt["context"]
        if arm == "baseline" or kind not in binding["expected_scopes"]:
            if context is not None or receipt["scenario_reads"]:
                raise ValueError("持久依据出现本组未授权的分层范围。")
            continue
        frozen = binding["installed"][kind]
        if not isinstance(context, dict):
            raise ValueError("持久依据的安装版本已变化。")
        # 与生产选择器共用完整条目及字符预算语义，允许跳过大项和仅保留目录。
        from notalone.memory.layered import LayeredMemorySnapshot, ScenarioDirectoryEntry
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget, select_material
        from notalone.scopes import ContactScope, OwnerScope
        scope = frozen["scope"]
        snapshot = LayeredMemorySnapshot(schema_version=1,
            scope=ContactScope(UUID(scope["owner_id"]), UUID(scope["contact_id"])) if kind == "contact"
                else OwnerScope(UUID(scope["owner_id"])),
            settings_generation=frozen["settings_generation"], organization_generation=frozen["organization_generation"],
            scenarios=tuple(ScenarioDirectoryEntry(UUID(item["scenario_id"]), UUID(item["version_id"]),
                item["title"], item["hint"], len(item["paragraphs"])) for item in frozen["scenarios"]),
            dependency_ids=(), profile_version_id=UUID(frozen["profile_version_id"]),
            profile_entries=tuple(frozen["profile_entries"]))
        read = context.get("scenario_read_budget")
        read_budget = ScenarioReadBudget(read["call_limit"], read["paragraph_limit"], read["character_limit"]) if read else None
        budget = LayeredReplyBudget(**context["budget"], scenario_read=read_budget)
        selected = select_material(snapshot, budget)
        if selected is None or selected.to_payload() != context:
            raise ValueError("持久依据不等于冻结安装在本次预算下的合法完整条目。")
        scenarios = {item["scenario_id"]: item for item in frozen["scenarios"]}
        for item in context.get("directory", []):
            prior = scenarios.get(item["scenario_id"])
            if (prior is None or any(item.get(key) != prior[key] for key in ("version_id", "title", "hint"))
                    or item.get("paragraph_count") != len(prior["paragraphs"])):
                raise ValueError("持久主题目录不属于获审安装版本。")
        for read in receipt["scenario_reads"]:
            if read.get("status") != "succeeded":
                continue
            document = read["document"]
            prior = scenarios.get(read["scenario_id"])
            start, end = read["paragraph_range"]
            if (prior is None or not 0 <= start < end <= len(prior["paragraphs"])
                    or any(document.get(key) != prior[key] for key in ("scenario_id", "version_id", "title", "hint"))
                    or document.get("organization_generation") != frozen["organization_generation"]
                    or document.get("paragraphs") != prior["paragraphs"][start:end]):
                raise ValueError("持久主题读取正文不属于获审安装版本。")
    return actual


