"""显式合成输入的双组回复评测；失败仍占分母，默认不执行模型调用。"""

from __future__ import annotations

from copy import deepcopy
import argparse
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID
from uuid import uuid4

from notalone.memory.organization_quality import content_digest
from notalone.memory_extraction.evaluation_http_budget import EvaluationBudgetAbort


class ReplyComparisonBlocked(RuntimeError):
    """输入、安装或公开HTTP门禁未就绪；不替换场景或重试。"""


def _validate_test_database(database_url: str, expected_database: str) -> None:
    import psycopg
    if not re.fullmatch(r"[A-Za-z0-9_]{1,58}_test", expected_database):
        raise ValueError("必须明确自有_test数据库身份。")
    with psycopg.connect(database_url) as connection:
        if connection.info.dbname != expected_database:
            raise ValueError("实际数据库与明确授权的_test身份不一致。")


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


def capture_installation_state(layered_memory, scope: dict, *, expected_scopes=None) -> dict:
    """沿现有合法读取接口固定两侧的实际版本及完整正文。"""
    from notalone.scopes import ContactScope, OwnerScope
    states = {}
    for kind, value in (("contact", ContactScope(UUID(scope["owner_id"]), UUID(scope["contact_id"]))),
                        ("owner", OwnerScope(UUID(scope["owner_id"])))):
        snapshot = layered_memory.capture(value)
        if snapshot is None:
            states[kind] = None
            continue
        if expected_scopes is not None and kind not in expected_scopes:
            raise ReplyComparisonBlocked("unexpected_installed_layered_scope")
        scenarios = []
        for item in snapshot.scenarios:
            document = layered_memory.read_scenario(snapshot, item.scenario_id, (0, item.paragraph_count))
            body = {key: document[key] for key in ("title", "hint", "paragraphs")}
            scenarios.append({"scenario_id": str(item.scenario_id), "version_id": str(item.version_id),
                              **body, "body_sha256": content_digest(body)})
        entries = list(snapshot.profile_entries)
        states[kind] = {"scope": {"owner_id": scope["owner_id"],
                                  "contact_id": scope["contact_id"] if kind == "contact" else None},
            "settings_generation": snapshot.settings_generation, "organization_generation": snapshot.organization_generation,
            "profile_version_id": str(snapshot.profile_version_id) if snapshot.profile_version_id else None,
            "profile_entries": entries, "profile_sha256": content_digest(entries), "scenarios": scenarios}
    return states


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


def build_manifest(*, contract, model_configuration: dict, dataset_version: str,
                   cases: list[dict], coverage_kind: str = "smoke", request_limit: int = 48) -> dict:
    if type(request_limit) is not int or not 1 <= request_limit <= 48:
        raise ValueError("回复比较总物理调用上限须为1至48的整数。")
    if (not 1 <= len(cases) <= 4 or coverage_kind not in {"smoke", "formal"}
            or not isinstance(dataset_version, str) or not dataset_version.strip()
            or contract.model_version != content_digest(model_configuration)):
        raise ValueError("输入规模、数据版本或实际模型配置与回复合同不一致。")
    members = []
    for case in cases:
        package = canonical_input(case["input_package"])
        scope = package.get("scope", {})
        content = package.get("request", {}).get("content", {})
        if (scope.get("confirmed") is not True or not scope.get("owner_id") or not scope.get("contact_id")
                or not scope.get("confirmation_receipt") or not package.get("l1_version")
                or content.get("include_relationship_context") is not True
                or case.get("scope_kind") not in {"owner", "contact"}):
            raise ValueError("每例须有已确认联系人回执、完整请求、开启关系语境和同一L1版本。")
        members.append({"case_id": case["case_id"], "input_sha256": content_digest(package),
                        "scope_kind": case["scope_kind"],
                        "organization_output_sha256": case.get("organization_output_sha256"),
                        "organization_review": deepcopy(case.get("organization_review"))})
        if "installation_binding" in case:
            members[-1]["installation_binding"] = deepcopy(case["installation_binding"])
    if len({item["case_id"] for item in members}) != len(members):
        raise ValueError("case_id须唯一。")
    return {"reply_contract": contract.to_payload(), "contract_id": contract.identity,
            "model_configuration": deepcopy(model_configuration), "data_kind": "synthetic",
            "coverage_kind": coverage_kind, "dataset_version": dataset_version,
            "input_package_version": "confirmed-reply-input-v1", "cases": members,
            "request_limit": request_limit, "per_arm_limit": 6}


def run_reply_comparison(*, manifest: dict, cases: list[dict], capture, invoke_arm) -> dict:
    """同一case逐组执行一次；硬门停止后其余组保持not_run。"""
    if capture.manifest != manifest or len(cases) != len(manifest["cases"]):
        raise ValueError("捕获器与冻结输入不一致。")
    by_id = {case["case_id"]: deepcopy(case) for case in cases}
    for member in manifest["cases"]:
        if (member["case_id"] not in by_id
                or content_digest(canonical_input(by_id[member["case_id"]]["input_package"])) != member["input_sha256"]
                or member.get("installation_binding") != by_id[member["case_id"]].get("installation_binding")):
            raise ValueError("完整输入摘要在执行前发生变化。")
    try:
        with capture.budget.batch():
            for member in manifest["cases"]:
                for arm in ("baseline", "layered"):
                    with capture.arm(member["case_id"], arm) as row:
                        row["evidence"]["input_package"] = canonical_input(by_id[member["case_id"]]["input_package"])
                        try:
                            if arm == "layered" and ((member.get("organization_review") or {}).get("decision") != "approved"
                                    or not re.fullmatch(r"[0-9a-f]{64}", member.get("organization_output_sha256") or "")):
                                raise ReplyComparisonBlocked("organization_candidate_not_approved")
                            result = invoke_arm(deepcopy(by_id[member["case_id"]]), arm, str(uuid4()), capture)
                            if not isinstance(result, dict) or not result.get("request_id") or result.get("output") is None:
                                raise ValueError("生成结果缺少真实请求身份或输出。")
                            evidence = result.get("evidence", {})
                            if (not isinstance(evidence, dict) or set(evidence) & {
                                    "input_package", "first_model_request", "input_budget", "input_budgets"}):
                                raise ValueError("Adapter不能覆盖捕获器记录的实际输入或预算。")
                            row["request_id"], row["output"] = result["request_id"], result["output"]
                            row["evidence"].update(evidence)
                            row["status"] = "succeeded"
                        except EvaluationBudgetAbort as error:
                            row["status"], row["error"] = "blocked", {"kind": str(error)}
                            raise
                        except ReplyComparisonBlocked as error:
                            row["status"], row["error"] = "blocked", {"kind": str(error)}
                        except Exception as error:
                            row["status"], row["error"] = "failed", {"kind": type(error).__name__}
    except EvaluationBudgetAbort:
        pass
    finally:
        capture.close()
    return deepcopy(capture.bundle)


class InstalledReplyHttpAdapter:
    """已安装scope沿新会话、准备、生成、依据四个公开HTTP接口运行。"""

    def __init__(self, request, *, check_l1_version=None, check_installation=None):
        self._request = request
        self._check_l1_version = check_l1_version
        self._check_installation = check_installation

    @staticmethod
    def request_confirmed_contact(client, *, token: str, contact_id: str,
                                  method: str, path: str, body):
        contact_id = str(UUID(contact_id))
        prefix = f"/api/contacts/{contact_id}/"
        if (not path.startswith(prefix)
                or isinstance(body, dict) and body.get("contact_id", contact_id) != contact_id):
            raise ReplyComparisonBlocked("http_contact_scope_changed")
        headers = {"Authorization": f"Bearer {token}"}
        # 正式HTTP门仅允许具名助手端点携带手动scope；依据读取沿owner/contact鉴权。
        if path.startswith(prefix + "assistant-session"):
            headers["X-NotAlone-Manual-Contact"] = contact_id
        response = client.request(method, path, headers=headers,
                                  body=json.dumps(body).encode() if body is not None else b"")
        return response.status_code, response.json()

    def __call__(self, case: dict, arm: str, request_key: str, capture) -> dict:
        package = case["input_package"]
        scope = package["scope"]
        if self._check_l1_version is not None:
            self._check_l1_version(package)
        installation = self._check_installation(case) if self._check_installation is not None else None
        request = self._request
        contact = scope["contact_id"]

        def call(method, path, payload=None):
            status, body = request(scope["owner_id"], arm, method, path, payload)
            capture.http_step(method=method, path=path, status=status, response=body, request=payload)
            if status != 200:
                raise ReplyComparisonBlocked(f"http_{status}_{body.get('error', 'unknown')}")
            return body

        session = call("POST", f"/api/contacts/{contact}/assistant-sessions", {})
        path = f"/api/contacts/{contact}/assistant-sessions/{session['session_id']}"
        body = deepcopy(package["request"])
        body.update({"contact_id": contact, "idempotency_key": request_key})
        prepared = call("POST", path + "/replies/prepare", body)
        if prepared.get("request_key") != request_key:
            raise ReplyComparisonBlocked("prepared_request_identity_changed")
        if self._check_installation is not None and self._check_installation(case) != installation:
            raise ReplyComparisonBlocked("installed_layered_material_changed")
        generated = call("POST", path + "/replies", body)
        identifier = generated["reply_request_id"]
        evidence = call("GET", f"/api/contacts/{contact}/replies/{identifier}/evidence")
        if self._check_l1_version is not None:
            self._check_l1_version(package)
        if self._check_installation is not None:
            if self._check_installation(case) != installation:
                raise ReplyComparisonBlocked("installed_layered_material_changed")
            try:
                validate_persisted_installation(case["installation_binding"], evidence, arm)
            except (ValueError, KeyError, TypeError):
                raise ReplyComparisonBlocked("persisted_layered_material_changed") from None
        return {"request_id": identifier, "output": generated,
                "evidence": {"session_id": session["session_id"], "request_key": request_key,
                             "preparation": prepared, "reply_evidence": evidence,
                             "installation_receipt": installation,
                             "l1_budget": {kind: {key: budget[key] for key in ("limit", "char_limit")}
                                 for kind, budget in evidence.get("retrieval", {}).get("budgets", {}).items()
                                 if kind in {"contact_memory", "owner_memory", "pending_candidate"}},
                             "l1_version": package["l1_version"]}}

    @classmethod
    def from_installed_database(cls, *, database_url: str, expected_database: str,
                                model, capture, contact_budget, owner_budget,
                                layered_memory=None):
        """只连接operator指明的自有_test库；不安装资料、不启动后台整理。"""
        from unittest.mock import patch
        from notalone.application.assistant_session_service import AssistantSessionService
        from notalone.application.contact_directory import ContactDirectory
        from notalone.application.layered_memory_service import LayeredMemoryService
        from notalone.application.reply_evidence import ReplyEvidenceService
        from notalone.persistence.assistant_session_catalog import PostgresAssistantSessionCatalog
        from notalone.persistence.assistant_session_store import PostgresAssistantSessionStore
        from notalone.persistence.contact_directory import PostgresContactDirectory
        from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
        from notalone.persistence.reply_store import PostgresReplyStore
        from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
        from notalone.reply.quality import reply_model_configuration
        from notalone.server.app import BackendApp
        from notalone.server.event_bus import EventBus
        from notalone.server.reply_wiring import build_reply_service
        from notalone.server.testing import InProcessClient

        _validate_test_database(database_url, expected_database)
        actual = reply_model_configuration(model)
        if (actual != capture.manifest["model_configuration"]
                or any(value != 0 for value in (model.max_retries, model.root_client.max_retries,
                                                model.root_async_client.max_retries))
                or model.root_client._client is not capture.http_client
                or model.root_async_client._client is not capture.http_async_client):
            raise ValueError("实际SDK参数、重试或捕获客户端与冻结合同不一致。")
        capability = build_deepseek_input_budget(model)
        if capability is None:
            raise ValueError("实际模型没有已核实输入预算。")
        profile, counter = capability
        layered = layered_memory or LayeredMemoryService(PostgresLayeredMemoryStore(database_url))
        clients = {}
        confirmed_scopes = {}
        active_cases = {}
        current_case = [None]

        def check_l1(package):
            if installed_l1_version(database_url, package["scope"]) != package["l1_version"]:
                raise ReplyComparisonBlocked("installed_l1_version_changed")
            confirmed_scopes[package["scope"]["owner_id"]] = package["scope"]["contact_id"]

        def check_installation(case):
            try:
                binding = case["installation_binding"]
                digest = validate_installation_binding(binding, case["organization_output_sha256"], case["organization_review"])
                if binding["expected_scopes"] != [case["scope_kind"]]:
                    raise ValueError("C候选原范围与安装范围不一致。")
                scope = case["input_package"]["scope"]
                states = capture_installation_state(layered, scope, expected_scopes=binding["expected_scopes"])
                installed = {kind: state for kind, state in states.items() if state is not None}
                if installed != binding["installed"]:
                    raise ReplyComparisonBlocked("installed_layered_material_changed")
                for kind in binding["expected_scopes"]:
                    if (contact_budget if kind == "contact" else owner_budget) is None:
                        raise ReplyComparisonBlocked("layered_budget_missing_for_expected_scope")
                active_cases[scope["owner_id"]] = case
                current_case[0] = case
                return {"binding_sha256": digest, "expected_scopes": binding["expected_scopes"],
                        "uncovered_scopes": [kind for kind in ("contact", "owner") if kind not in installed],
                        "installed": installed}
            except (ValueError, KeyError, TypeError):
                raise ReplyComparisonBlocked("installation_binding_invalid") from None

        def on_input_budget(decision):
            # 运行时每轮计量后、SDK发送前重新核对，独立于L1版本守卫。
            if current_case[0] is not None:
                check_installation(current_case[0])
            capture.input_budget(decision)

        def request(owner_id, arm, method, path, body):
            contact_id = confirmed_scopes.get(owner_id)
            if contact_id is None or not path.startswith(f"/api/contacts/{contact_id}/"):
                raise ReplyComparisonBlocked("http_contact_scope_changed")
            key = (owner_id, arm)
            expected = active_cases[owner_id]["installation_binding"]["expected_scopes"]
            key = (owner_id, contact_id, arm, tuple(expected))
            if key not in clients:
                # 同一真实SDK，baseline只省去两个分层预算，其余构造保持一致。
                with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=model):
                    service = build_reply_service(database_url=database_url, owner_id=UUID(owner_id),
                        layered_memory=layered,
                        layered_reply_budget=contact_budget if arm == "layered" and "contact" in expected else None,
                        owner_layered_reply_budget=owner_budget if arm == "layered" and "owner" in expected else None,
                        input_budget_profile=profile, input_token_counter=counter,
                        on_input_budget=on_input_budget)
                if service is None:
                    raise ReplyComparisonBlocked("reply_service_unavailable")
                token = str(uuid4())
                app = BackendApp(contact_directory=ContactDirectory(PostgresContactDirectory(database_url)),
                    events=EventBus(), owner_id=UUID(owner_id), token=token, reply_service=service,
                    assistant_sessions=AssistantSessionService(store=PostgresAssistantSessionStore(database_url),
                        reply=service, catalog=PostgresAssistantSessionCatalog(database_url)),
                    reply_evidence=ReplyEvidenceService(PostgresReplyStore(database_url)), layered_memory=layered)
                clients[key] = (InProcessClient(app), token)
            client, token = clients[key]
            return cls.request_confirmed_contact(client, token=token, contact_id=contact_id,
                                                 method=method, path=path, body=body)

        return cls(request, check_l1_version=check_l1, check_installation=check_installation)


def installed_l1_version(database_url: str, scope: dict) -> str:
    """固定同一联系人与本人L1的当前版本；正文不进入版本回执。"""
    import psycopg
    with psycopg.connect(database_url) as connection:
        confirmation = connection.execute(
            "SELECT id FROM public.manual_contact_confirmation WHERE owner_id=%s AND contact_id=%s",
            (UUID(scope["owner_id"]), UUID(scope["contact_id"]))).fetchone()
        if confirmation is None:
            raise ReplyComparisonBlocked("installed_contact_not_confirmed")
        receipt_id = scope.get("confirmation_receipt", {}).get("confirmation_id")
        if receipt_id is not None and str(confirmation[0]) != receipt_id:
            raise ReplyComparisonBlocked("installed_confirmation_receipt_changed")
        contact = connection.execute(
            "SELECT id,revision,status FROM public.confirmed_memory WHERE owner_id=%s AND contact_id=%s ORDER BY id",
            (UUID(scope["owner_id"]), UUID(scope["contact_id"]))).fetchall()
        owner = connection.execute("SELECT id,revision,status FROM public.owner_memory WHERE owner_id=%s ORDER BY id",
                                   (UUID(scope["owner_id"]),)).fetchall()
    return content_digest({"contact": contact, "owner": owner, "confirmation_id": confirmation[0]})


def _budget(value):
    from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
    if value is None:
        return None
    payload = deepcopy(value)
    if payload.get("scenario_read") is not None:
        payload["scenario_read"] = ScenarioReadBudget(**payload["scenario_read"])
    return LayeredReplyBudget(**payload)


def controlled_layered_memory(database_url):
    """公开CLI的受控只读装配；适配器满足deadline合同并拒绝任何整理调用。"""
    from notalone.application.layered_memory_service import LayeredMemoryService
    from notalone.memory.organization_deadline import SYNTHETIC_ORGANIZATION_TIMEOUT
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore

    class DisabledProposal:
        timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

        def propose(self, *, deadline, **kwargs):
            raise ReplyComparisonBlocked("organization_not_authorized")

    class DisabledVerification:
        timeout_contract = SYNTHETIC_ORGANIZATION_TIMEOUT

        def verify(self, *, deadline, **kwargs):
            raise ReplyComparisonBlocked("organization_not_authorized")

    return LayeredMemoryService(PostgresLayeredMemoryStore(database_url),
        proposer=DisabledProposal(), verifier=DisabledVerification(), synthetic=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-package", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--execute", action="store_true", help="明确执行已安装合成scope的真实SDK双组冒烟")
    parser.add_argument("--synthetic-confirmed", action="store_true")
    parser.add_argument("--database-url-env")
    parser.add_argument("--expected-test-database")
    parser.add_argument("--api-key-env")
    parser.add_argument("--controlled-layered-installation", action="store_true",
                        help="仅在明确_test库内读取已受控安装的合成版本，不授予自动使用资格")
    args = parser.parse_args(argv)
    try:
        package = json.loads(args.input_package.read_text(encoding="utf-8"))
        manifest, cases = package["manifest"], package["cases"]
        from notalone.reply.adapters.reply_comparison_capture import ReplyComparisonCapture
        if not args.execute:
            def blocked(*_):
                raise ReplyComparisonBlocked("execution_not_requested")
            capture = ReplyComparisonCapture(args.output_directory, manifest)
            bundle = run_reply_comparison(manifest=manifest, cases=cases, capture=capture, invoke_arm=blocked)
        else:
            if (not args.synthetic_confirmed or not args.expected_test_database
                    or any(not name or not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,119}", name)
                           for name in (args.database_url_env, args.api_key_env))):
                raise ValueError("执行须明确合成授权、_test身份及两个operator环境变量名。")
            database_url, api_key = os.environ[args.database_url_env], os.environ[args.api_key_env]
            from notalone.reply.adapters.deepseek_provider import build_deepseek_model
            from notalone.reply.adapters.deepseek_input_budget import build_deepseek_input_budget
            from notalone.reply.quality import build_reply_contract, reply_model_configuration
            capture = ReplyComparisonCapture(args.output_directory, manifest)
            try:
                model = build_deepseek_model(api_key=api_key, model_name="deepseek-flash",
                    base_url="https://api.deepseek.com", max_retries=0,
                    extra_body={"thinking": {"type": "disabled"}},
                    http_client=capture.http_client, http_async_client=capture.http_async_client)
                contact_budget, owner_budget = _budget(package["contact_budget"]), _budget(package["owner_budget"])
                capability = build_deepseek_input_budget(model)
                if capability is None:
                    raise ValueError("实际SDK输入预算不可用。")
                contract = build_reply_contract(model, capability[0], contact_budget, owner_budget)
                expected = build_manifest(contract=contract, model_configuration=reply_model_configuration(model),
                    dataset_version=manifest["dataset_version"], cases=cases,
                    coverage_kind=manifest["coverage_kind"])
                if manifest != expected:
                    raise ValueError("实际SDK合同与冻结输入不一致。")
                layered = None
                if args.controlled_layered_installation:
                    _validate_test_database(database_url, args.expected_test_database)
                    layered = controlled_layered_memory(database_url)
                    capture.bundle["installation_kind"] = "controlled_synthetic"
                    capture.flush()
                adapter = InstalledReplyHttpAdapter.from_installed_database(database_url=database_url,
                    expected_database=args.expected_test_database, model=model, capture=capture,
                    contact_budget=contact_budget, owner_budget=owner_budget, layered_memory=layered)
                bundle = run_reply_comparison(manifest=manifest, cases=cases, capture=capture, invoke_arm=adapter)
            finally:
                capture.close()
        print(json.dumps({"bundle": str(capture.path), "manifest_sha256": bundle["manifest_sha256"],
            "cases": len(manifest["cases"]), "arms": [{key: row[key] for key in ("case_id", "arm", "status")}
                for row in bundle["arms"]], "physical_attempts": len(bundle["calls"]),
            "closed": bundle["budget_receipt"]["closed"]}, ensure_ascii=False))
        return 0
    except (ValueError, KeyError, OSError, EvaluationBudgetAbort) as error:
        print(json.dumps({"error": type(error).__name__}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
