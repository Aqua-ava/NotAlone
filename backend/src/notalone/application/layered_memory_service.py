"""有限主题整理的管理入口；逐项核验维护与显式质量评测分别执行。"""

from notalone.memory.organization_isolation import isolate_proposal, select_verified

from copy import deepcopy
from dataclasses import replace
from contextlib import nullcontext
import json
import math
import inspect
from threading import Lock

from notalone.memory.layered import OrganizationBudget, OrganizationBudgetExhausted, LayeredMemoryConflict
from notalone.memory.scenario_validation import validate_proposal
from notalone.memory.owner_organization_input import organization_model_memories, organization_model_scenarios
from notalone.memory.profile_validation import validate_profile
from notalone.memory.layered_correction_validation import validate_correction_proposal
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from notalone.application.organization_call import (
    bounded_organization_call, OrganizationCallTimeout, require_adapter_timeout_contract,
)


class LayeredMemoryService:
    def __init__(self, store, *, proposer=None, verifier=None, synthetic=False,
                 budget=None, model_priority=None, call_timeout_seconds=30.0, task_host=None, dispatcher=None,
                 profile_proposer=None, profile_verifier=None, quality=None, synthetic_quality_required=False, adapter_close=None,
                 runtime_policy="qualified_suite"):
        if (not isinstance(call_timeout_seconds, (int, float)) or isinstance(call_timeout_seconds, bool)
                or not math.isfinite(call_timeout_seconds) or not 0 < call_timeout_seconds <= 120):
            raise ValueError("整理调用必须有不超过120秒的有限等待。")
        from notalone.memory.organization_quality import OrganizationQualityService, OrganizationQualityContract
        from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
        self._budget = budget or (quality.organization_contract.budget if quality is not None
            else OrganizationBudget(max_model_calls=4 if profile_proposer else 2))
        self._quality = quality or OrganizationQualityService(PostgresOrganizationQualityStore(store),
            organization_contract=OrganizationQualityContract(budget=self._budget))
        if type(synthetic_quality_required) is not bool or synthetic_quality_required and not synthetic:
            raise ValueError('受控资格链仅允许显式隔离合成装配。')
        if synthetic_quality_required and runtime_policy != 'qualified_suite':
            raise ValueError('显式评测资格要求不能被日常维护策略覆盖。')
        if runtime_policy not in {"qualified_suite", "verified_items"}:
            raise ValueError("未知的整理运行策略。")
        self.runtime_policy = runtime_policy
        self._quality_required = (not synthetic or synthetic_quality_required) and runtime_policy == "qualified_suite"
        self._call_timeout_seconds = call_timeout_seconds
        self._task_host = task_host
        self._change_feed = None
        self._maintenance_lock = Lock()
        self._maintenance_stopped = False
        self._adapter_close = adapter_close
        self._dispatcher = dispatcher
        self._contract = "scenario-v3:deadline-v1:coverage-v1:correction-v1:" + runtime_policy
        if getattr(proposer, "personal", False):
            self._contract += ":personal-background-v1:l2-1500:l3-2000"
        if getattr(proposer, "document_tools", False):
            self._contract += ":document-tools-v1:physical-budget-v1"
        self._store, self._proposer, self._verifier = store, proposer, verifier
        if synthetic:
            store.require_synthetic_database()
            if proposer is None or verifier is None or proposer is verifier:
                raise ValueError("受控整理须分别注入提案和独立核验适配器。")
            require_adapter_timeout_contract(proposer, "propose", synthetic=True)
            require_adapter_timeout_contract(verifier, "verify", synthetic=True)
        self._scenario_context = bool(proposer is not None and verifier is not None and
            'scenarios' in inspect.signature(proposer.propose).parameters and
            'scenarios' in inspect.signature(verifier.verify).parameters)
        if self._scenario_context:
            self._contract += ':scenario-context-v1'
        self._profile_proposer, self._profile_verifier = profile_proposer, profile_verifier
        if (profile_proposer is None) != (profile_verifier is None):
            raise ValueError("长期背景须同时装配独立提案和核验适配器。")
        if profile_proposer is not None:
            if profile_proposer is profile_verifier:
                raise ValueError("长期背景须分别装配独立提案和核验。")
            require_adapter_timeout_contract(profile_proposer, "propose", synthetic=synthetic)
            require_adapter_timeout_contract(profile_verifier, "verify", synthetic=synthetic)
        self.reply_configuration = None
        self._synthetic = synthetic
        if profile_proposer and runtime_policy == "qualified_suite" and self._budget.max_model_calls != 4:
            raise ValueError("长期背景装配要求显式四步有限预算。")
        if profile_proposer:
            self._contract += ":profile-tools-v1" if getattr(profile_proposer, "document_tools", False) else ":profile-v1"
        self._priority = model_priority or ModelPriorityControl()
        self._real_adapters = self._actual_adapters_match_contract()
        if not synthetic and any(adapter is not None for adapter in (proposer, verifier, profile_proposer, profile_verifier)) and not self._real_adapters:
            raise ValueError('真实整理须装配同合同的实际候选四阶段SDK Adapter。')

    def _contract_for(self, scope):
        return self._contract + (":owner-input-v1" if scope.contact_id is None else "") + ":" + self._quality.organization_contract.identity

    def _actual_adapters_match_contract(self):
        from notalone.memory.organization_sdk import actual_organization_adapters
        ports = (self._proposer, self._verifier, self._profile_proposer, self._profile_verifier)
        contract = self._quality.organization_contract
        if not actual_organization_adapters(ports, runtime_policy=self.runtime_policy):
            return False
        return (contract.provider == contract.verifier_provider == 'deepseek'
            and contract.budget == self._budget
            and all(adapter.model.model_name == (contract.verifier_model if i % 2 else contract.request_model)
                    for i, adapter in enumerate(ports)))

    def _organization_available(self, owner_id):
        return (owner_id is not None and (self._synthetic or self._real_adapters)
            and (not self._quality_required or self._quality.status(owner_id)['organization']['status'] == 'verified'))

    def _publication_guard(self, owner_id, snapshot):
        return nullcontext(lambda connection: None) if not self._quality_required else self._quality.publication_guard(owner_id, snapshot)

    def _read_available(self, owner_id):
        return self._reading_receipt(owner_id) is not None

    def attach_task_host(self, task_host):
        self._task_host=task_host

    def attach_dispatcher(self, dispatcher):
        if self._dispatcher is None:
            self._dispatcher=dispatcher

    def start_maintenance(self, owner_id):
        if owner_id is None or not (self._synthetic or self._real_adapters) or (self._task_host is None and self._dispatcher is None):
            return
        with self._maintenance_lock:
            if self._maintenance_stopped or self._change_feed is not None:
                return
            previously_available = False
            def dispatch_due():
                nonlocal previously_available
                if not self._organization_available(owner_id):
                    previously_available = False
                    return 0.5
                if not previously_available:
                    self.resume_pending(owner_id)
                    previously_available = True
                scopes, delay = self._store.maintenance_due(owner_id)
                for scope in scopes:
                    task_id = self._store.enqueue_maintenance(scope, self._budget, self._contract_for(scope),
                        profile_required=self._profile_proposer is not None)
                    if task_id is not None:
                        self._dispatch(scope, task_id)
                return delay
            self._change_feed = self._store.start_change_feed(owner_id, dispatch_due)

    def stop(self):
        self._priority.stop()
        with self._maintenance_lock:
            self._maintenance_stopped = True
            feed = self._change_feed
        if feed is not None:
            feed.stop()
        if self._adapter_close is not None:
            close, self._adapter_close = self._adapter_close, None
            close()

    def resume_pending(self, owner_id):
        if owner_id is None or not self._organization_available(owner_id) or (self._task_host is None and self._dispatcher is None):
            return
        for scope in self._store.pending_scopes(owner_id):
            task_id=self._store.pending(scope,self._contract_for(scope))
            if task_id is not None:
                self._dispatch(scope,task_id)

    def read(self, scope, *, mapping_cursor=None):
        if self._organization_available(scope.owner_id):
            task_id=self._store.pending(scope,self._contract_for(scope))
            if task_id is not None:
                self._dispatch(scope,task_id)
        state, entries, scenarios, job = self._store.read(scope, mapping_cursor=mapping_cursor)
        covered = state["covered_count"]
        used = job["model_calls_used"] if job else 0
        limit = job["model_call_limit"] if job else self._budget.max_model_calls
        return {"schema_version": 2, "scope_kind": "owner" if scope.contact_id is None else "contact", "contact_id": str(scope.contact_id) if scope.contact_id is not None else None,
                "settings_generation": state["settings_generation"], "enabled": state["enabled"],
                "runtime_policy": "qualification" if self.runtime_policy == "qualified_suite" else self.runtime_policy,
                "quality_status": "synthetic" if self._synthetic else self._quality.status(scope.owner_id)["organization"]["status"],
                "quality": self._quality.status(scope.owner_id, synthetic=self._synthetic),
                "status": state["status"], "eligible_count": len(entries), "covered_count": covered,
                "remaining_count": max(0, len(entries)-covered),
                "work_id": str(job['task_id']) if job else None,
                "work_revision": job['revision'] if job else 0,
                "current_batch": job['batch_number'] if job else 0,
                "model_calls_used": used,
                "model_call_limit": limit,
                "organization_generation": state["organization_generation"],
                "updated_at": state["updated_at"].isoformat() if state["updated_at"] else None,
                "error_code": state["error_code"], "scenarios": scenarios, "profile": state["profile"],
                "correction_revision": state['correction_revision'], "feedback": state['feedback'],
                "protected_count": state['protected_count'], "pending_fact_count": state['pending_fact_count'],
                "maintenance_pending": state["dirty_revision"] > state["consumed_revision"],
                "scenario_mappings": state["scenario_mappings"],
                "mapping_cursor": state["mapping_cursor"],
                "mapping_next_cursor": state["mapping_next_cursor"],
                "purpose": ("从本人已采纳且来历有效的记忆整理主题背景，模型仅接收本人正文、时间与必要引用。" if scope.contact_id is None
                    else "从本联系人已采纳且来历有效的记忆整理主题背景，供查看及后续受控回复使用。"),
                "budget": {**self._budget.to_payload(), "max_model_calls": limit,
                    "model_calls_used": used, "model_calls_remaining": limit-used}}

    def prepare_quality_input(self, scope, versions):
        return self._quality._store.prepare(scope, versions, self._quality.organization_contract)

    def command(self, scope, action, expected_generation, expected_work_revision=None):
        if action in {'pause','continue'}:
            if not self._organization_available(scope.owner_id):
                raise LayeredMemoryConflict('当前没有已获资格的覆盖工作。')
            state,_,_,_=self._store.read(scope)
            if state['settings_generation']!=expected_generation:
                raise LayeredMemoryConflict('范围设置已变化。')
        else:
            self._store.command(scope, action, expected_generation, quality_available=self._organization_available(scope.owner_id))
        if self._organization_available(scope.owner_id) and action in {'enable','refresh','pause','continue'}:
            task_id, execute = self._store.enqueue(scope,self._budget,self._contract_for(scope),action=action,revision=expected_work_revision,profile_required=self._profile_proposer is not None)
            if execute:
                self._dispatch(scope,task_id)
        return self.read(scope)

    def organize(self, scope):
        """统一变化通知入口；同范围L2及L3仍由正式Worker的一次有限批次执行。"""
        if not self._organization_available(scope.owner_id):
            return
        task_id, execute = self._store.enqueue(scope,self._budget,self._contract_for(scope),
            profile_required=self._profile_proposer is not None)
        if execute:
            self._dispatch(scope,task_id)

    def _dispatch(self, scope, task_id):
        if self._task_host is not None:
            self._task_host.wake(owner_id=scope.owner_id,contact_id=scope.contact_id,task_id=task_id)
            return
        if self._dispatcher is None:
            raise RuntimeError('主题整理缺少已装配的任务调度器。')
        self._dispatcher(scope,task_id,runner=self,model_priority=self._priority)

    def run_batch(self, claim):
        from notalone.scopes import organization_scope
        scope=organization_scope(claim.owner_id,claim.contact_id)
        if not self._organization_available(scope.owner_id):
            raise PermissionError('整理质量资格尚未获准。')
        quality_snapshot = self._quality.snapshot(scope.owner_id) if self._quality_required else None
        work = self._store.prepare(scope,self._budget,self._contract_for(scope),claim, with_scenarios=self._scenario_context)
        if work is None:
            if self._profile_proposer:
                self._organize_profile(scope,claim)
            return 0
        try:
            raw = self._call(work, self._proposer, "propose", lambda deadline: self._proposer.propose(
                memories=self._model_memories(work), budget=self._budget, deadline=deadline,
                **self._correction_arguments(self._proposer, 'propose', work),
                **({"scenarios": self._model_scenarios(work)} if self._scenario_context else {})))
            original = deepcopy(raw)
            def validate_items(value):
                checked = validate_proposal(value, work.memories, self._budget, scenarios=work.scenarios)
                if self._scenario_context:
                    from notalone.memory.scenario_publication import require_explicit_replacements
                    require_explicit_replacements(work.scope, checked, work.scenarios)
                validate_correction_proposal(work, checked, personal=getattr(self._proposer, "personal", False))
                if getattr(self._proposer, 'document_tools', False):
                    from notalone.memory.scene_workspace import validate_document_replacements
                    validate_document_replacements(checked, work.scenarios)
                return checked
            raw, proposal, rejected = isolate_proposal(raw, 'scenarios', validate_items, self._budget.max_scenarios)
            self._store.record_proposal(work, {'original': original, 'filtered': raw, 'rejected': rejected})
            if original['scenarios'] and not raw['scenarios']:
                self._store.fail(work, 'proposal_invalid')
                return 0
            # 核验实际接收全部记忆和完整提案，两者合计仍受单次输入上限约束。
            verification_input = {"memories": [item.to_payload() for item in self._model_memories(work)], "proposal": raw}
            if work.corrections:
                verification_input['corrections'] = work.corrections
            if self._scenario_context:
                verification_input["scenarios"] = self._model_scenarios(work)
            if len(json.dumps(verification_input, ensure_ascii=False)) > self._budget.max_characters:
                self._store.fail(work, "verification_input_budget_exceeded")
                return 0
            operation = 'verify_items' if callable(getattr(self._verifier, 'verify_items', None)) else 'verify'
            supported = self._call(work, self._verifier, operation, lambda deadline: getattr(self._verifier, operation)(
                memories=self._model_memories(work), proposal=deepcopy(raw), deadline=deadline,
                **self._correction_arguments(self._verifier, operation, work),
                **({"scenarios": self._model_scenarios(work)} if self._scenario_context else {})))
            filtered, verification_rejected = select_verified(raw, 'scenarios', supported)
            self._store.record_proposal(work, {'original': original, 'filtered': filtered,
                'rejected': rejected, 'verification_rejected': verification_rejected, 'verification_result': supported})
            if raw['scenarios'] and not filtered['scenarios'] or supported is False:
                self._store.fail(work, "faithfulness_rejected")
                return 0
            proposal = validate_items(filtered)
            with self._publication_guard(scope.owner_id, quality_snapshot) as final_guard:
                self._store.publish(work, proposal, self._budget, qualification_guard=final_guard)
            if self._profile_proposer:
                self._organize_profile(scope,claim)
            return len(work.memories)
        except OrganizationBudgetExhausted:
            self._store.fail(work,"model_budget_exhausted")
        except OrganizationCallTimeout:
            self._store.fail(work, "model_call_timeout")
        except (LayeredMemoryConflict, ModelWorkStopped):
            self._store.fail(work, "input_changed")
        except (ConnectionError, TimeoutError):
            self._store.fail(work,'model_call_failed')
            raise
        except ValueError:
            self._store.fail(work, "proposal_invalid")
        except Exception:
            self._store.fail(work, "model_call_failed")
        return 0

    @staticmethod
    def _correction_arguments(adapter, operation, work):
        if not work.corrections:
            return {}
        if 'corrections' not in inspect.signature(getattr(adapter, operation)).parameters:
            raise ValueError('适配器尚未实现整理纠错对照合同。')
        return {'corrections': deepcopy(work.corrections)}

    @staticmethod
    def _model_memories(work):
        return deepcopy(organization_model_memories(work.scope, work.memories))

    @staticmethod
    def _model_scenarios(work):
        return deepcopy(organization_model_scenarios(work.scope, work.scenarios))

    def worker_failed(self, claim):
        self._store.worker_failed(claim)

    def _call(self, work, adapter, operation, call, *, guard=None):
        """两层共用许可、期限与持久额度政策；反复guard仅复验，不重复扣费。"""
        require_adapter_timeout_contract(adapter, operation, synthetic=self._synthetic)

        snapshot = self._quality.snapshot(work.scope.owner_id) if self._quality_required else None
        input_guard = guard or (lambda: self._store.check(work))
        def check():
            input_guard()
            if snapshot is not None:
                self._quality.validate_qualification(work.scope.owner_id, snapshot)
        def invoke(deadline):
            from notalone.memory.organization_quality_transport import organization_request_context
            check()
            physical = getattr(adapter, 'physical_accounting', False)
            if not physical:
                self._store.reserve_model_call(work)
            tail = (1 if getattr(adapter, 'layer', None) == 'l3' else 7 if self._profile_proposer else 1) if getattr(adapter, 'document_tools', False) and operation == 'propose' else 0
            phase = ('l3' if hasattr(work, 'scenario_version_ids') else 'l2') + ('_proposal' if operation == 'propose' else '_verification')
            context = (nullcontext() if self._synthetic and not physical else organization_request_context(
                check, lambda request, response, route: self._check_response_identity(work.scope.owner_id, snapshot, phase, request, response, route),
                deadline, self._budget, reserve=(lambda: self._store.reserve_model_call(work, reserved_calls=tail)) if physical else None))
            with context:
                value = call(deadline)
            check()
            return value
        return bounded_organization_call(invoke, priority=self._priority, guard=check, timeout_seconds=self._call_timeout_seconds,
                                         per_request=getattr(adapter, 'physical_scheduling', False))

    def default_reply_budgets(self):
        """逐项核验资料的有限默认读取；关系语境开关仍由回复流程控制。"""
        if self.runtime_policy != 'verified_items' or not (self._synthetic or self._real_adapters):
            return None
        from notalone.reply.layered_context import LayeredReplyBudget, ScenarioReadBudget
        return (LayeredReplyBudget(4, 4, 2400, ScenarioReadBudget(2, 8, 4000)),
                LayeredReplyBudget(4, 4, 1600, ScenarioReadBudget(2, 8, 2400)))

    def _check_response_identity(self, owner_id, snapshot, phase, request, response, route):
        if self._quality_required:
            self._quality.check_response_identity(owner_id, snapshot, phase, request, response, route)
            return
        # 日常维护不借用评测报告的指纹；仍核对实际请求模型和有身份的完整响应。
        contract = self._quality.organization_contract
        expected = contract.verifier_model if phase.endswith('verification') else contract.request_model
        if request.get('model') != expected or not isinstance(response.get('model'), str) or not response['model']:
            raise LayeredMemoryConflict('整理模型请求或响应身份不完整。')

    def configure_reply(self, contract, source):
        self._quality.configure_reply(contract, source)

    def _reading_receipt(self, owner_id, *, connection=None):
        if self.runtime_policy == 'verified_items' and self._organization_available(owner_id):
            # 策略身份不是评测通过回执；实际版本与来源仍在capture/validate中复验。
            return 'verified-items-v1:' + self._quality.organization_contract.identity
        if self._synthetic and not self._quality_required:
            return 'synthetic'
        return self._quality.reading_receipt(owner_id, connection=connection)

    def capture(self, scope):
        receipt = self._reading_receipt(scope.owner_id)
        if receipt is None:
            return None
        snapshot = self._store.capture(scope)
        return replace(snapshot, quality_receipt=receipt) if snapshot is not None else None

    def read_scenario(self, snapshot, id, range):
        if snapshot.quality_receipt is None or snapshot.quality_receipt != self._reading_receipt(snapshot.scope.owner_id):
            raise PermissionError("整理读取质量资格尚未获准或已变化。")
        return self._store.read_scenario(snapshot, id, range)

    def validate(self, snapshot):
        return (snapshot.quality_receipt is not None
            and snapshot.quality_receipt == self._reading_receipt(snapshot.scope.owner_id)
            and self._store.validate(snapshot))

    def validate_in_transaction(self, connection, snapshot):
        """最终writer沿原范围锁复验同一质量回执，不开启业务目标的第二事务。"""
        return (snapshot.quality_receipt is not None
            and snapshot.quality_receipt == self._reading_receipt(snapshot.scope.owner_id, connection=connection)
            and self._store.validate_in_transaction(connection, snapshot))

    def reading_guard(self, context):
        materials = [item for item in (context.layered_context, context.owner_layered_context) if item is not None]
        if not materials or self.runtime_policy == 'verified_items' or self._synthetic and not self._quality_required:
            return nullcontext()
        receipts = {item.snapshot.quality_receipt for item in materials}
        if len(receipts) != 1:
            raise LayeredMemoryConflict('两侧资料不是同一次有效读取资格。')
        return self._quality.reading_guard(context.scope.owner_id, receipts.pop())

    def validate_reply_model(self, prepared, model, profile, contact_budget, owner_budget):
        if self.runtime_policy == 'verified_items':
            return
        if self._synthetic and not self._quality_required:
            return
        if prepared.layered_context is not None or prepared.owner_layered_context is not None:
            from notalone.reply.quality import build_reply_contract
            current = build_reply_contract(model, profile, contact_budget, owner_budget)
            if current.identity != self._quality.reply_contract.identity:
                raise LayeredMemoryConflict('实际回复配置已变化，请重新核验读取资格。')

    def check_reply_response(self, prepared, model, message):
        if self.runtime_policy == 'verified_items':
            return
        if self._synthetic and not self._quality_required:
            return
        if prepared.layered_context is not None or prepared.owner_layered_context is not None:
            self._quality.check_reply_identity(prepared.scope.owner_id, model, message)

    def withdraw_scenario(self, scope, settings_generation, organization_generation, scenario_version_id):
        self._store.withdraw_scenario(scope, settings_generation, organization_generation, scenario_version_id)
        return self.read(scope)

    def report_summary_error(self, scope, command):
        self._store.report_summary_error(scope, command)
        if self._synthetic:
            self.organize(scope)
        return self.read(scope)

    def report_fact_error(self, scope, command):
        target = self._store.report_fact_error(scope, command)
        return {**self.read(scope), 'correction_target': target}

    def withdraw_profile(self, scope, settings_generation, organization_generation, profile_version_id):
        self._store.withdraw_profile(scope,settings_generation,organization_generation,profile_version_id)
        return self.read(scope)

    def _profile_context_arguments(self, work):
        parameters = inspect.signature(self._profile_proposer.propose).parameters
        previous = None
        if work.previous_profile is not None:
            previous = {"version_id": work.previous_profile['version_id'], "entries": [
                {**{key: item[key] for key in ("kind", "section", "basis") if key in item},
                 "text": item['text'], "temporal_status": item['temporal_status'],
                 "uncertainty": item['uncertainty'], "references": [
                     {key: ref[key] for key in ('memory_id', 'revision')} for ref in item['references']]}
                for item in work.previous_profile['entries']]}
        context = {"previous_profile": previous, "changed_scenario_ids": work.changed_scenario_ids}
        # 老的合成适配器仅用来核验既有服务合同；实际 SDK 必须接收完整更新上下文。
        return {key: value for key, value in context.items() if key in parameters}

    def _incremental_profile_arguments(self, work):
        if not getattr(self._profile_proposer, 'document_tools', False):
            return {}
        existing = deepcopy(work.existing_profile)
        if existing and work.scope.contact_id is None:
            existing = {'version_id': existing['version_id'], 'entries': [
                {key: entry[key] for key in ('text', 'temporal_status', 'uncertainty', 'kind', 'section', 'basis') if key in entry} | {'references': [
                    {key: ref[key] for key in ('memory_id', 'revision')} for ref in entry['references']]}
                for entry in existing['entries']]}
        return {'existing_profile': existing,
            'changed_scenarios': deepcopy(organization_model_scenarios(work.scope, work.changed_scenarios)),
            'removed_scenario_version_ids': work.removed_scenario_version_ids,
            'base_profile_version_id': str(work.base_profile_version_id) if work.base_profile_version_id else None}

    def _organize_profile(self, scope, claim):
        quality_snapshot = self._quality.snapshot(scope.owner_id) if self._quality_required else None
        work = self._store.prepare_profile(scope,self._budget,"profile-v1:synthetic-only:deadline-v1:correction-v1:" + self._contract +
            (":owner-input-v1" if scope.contact_id is None else "") + ":" + self._quality.organization_contract.identity,
            lease_seconds=self._call_timeout_seconds * 2 + 5,claim=claim,
            incremental=bool(getattr(self._profile_proposer, "document_tools", False)))
        if work is None:
            return
        try:
            raw = self._call(work,self._profile_proposer,"propose",lambda deadline: self._profile_proposer.propose(
                scenarios=self._model_scenarios(work),memories=self._model_memories(work),budget=self._budget,deadline=deadline,
                **self._profile_context_arguments(work),
                **self._correction_arguments(self._profile_proposer, 'propose', work),
                **self._incremental_profile_arguments(work)),
                guard=lambda: self._store.check_profile(work))
            original = deepcopy(raw)
            def validate_items(value):
                checked = validate_profile(value, work.memories, self._budget)
                validate_correction_proposal(work, checked, profile=True, personal=getattr(self._profile_proposer, "personal", False))
                return checked
            raw, proposal, rejected = isolate_proposal(raw, 'entries', validate_items, self._budget.max_profile_entries)
            self._store.record_profile_proposal(work, {'original': original, 'filtered': raw, 'rejected': rejected})
            if original['entries'] and not raw['entries']:
                self._store.fail_profile(work, 'profile_proposal_invalid')
                return
            payload = {"scenarios": list(self._model_scenarios(work)),"memories": [item.to_payload() for item in self._model_memories(work)],"proposal": raw}
            if work.corrections:
                payload['corrections'] = work.corrections
            if len(json.dumps(payload,ensure_ascii=False)) > self._budget.max_characters:
                self._store.fail_profile(work,"profile_verification_input_budget_exceeded")
                return
            operation = 'verify_items' if callable(getattr(self._profile_verifier, 'verify_items', None)) else 'verify'
            supported = self._call(work,self._profile_verifier,operation,lambda deadline: getattr(self._profile_verifier, operation)(
                scenarios=self._model_scenarios(work),memories=self._model_memories(work),proposal=deepcopy(raw),deadline=deadline,
                **self._correction_arguments(self._profile_verifier, operation, work),
                **self._incremental_profile_arguments(work)),
                guard=lambda: self._store.check_profile(work))
            filtered, verification_rejected = select_verified(raw, 'entries', supported)
            self._store.record_profile_proposal(work, {'original': original, 'filtered': filtered,
                'rejected': rejected, 'verification_rejected': verification_rejected, 'verification_result': supported})
            if raw['entries'] and not filtered['entries'] or supported is False:
                self._store.fail_profile(work,"profile_faithfulness_rejected")
                return
            proposal = validate_items(filtered)
            if getattr(self._profile_proposer, 'document_tools', False):
                from notalone.memory.profile_workspace import validate_incremental_profile
                validate_incremental_profile(proposal, work.existing_profile, work.changed_scenarios)
            with self._publication_guard(scope.owner_id, quality_snapshot) as final_guard:
                self._store.publish_profile(work,proposal,qualification_guard=final_guard)
        except OrganizationBudgetExhausted:
            self._store.fail_profile(work,"model_call_budget_exhausted")
        except OrganizationCallTimeout:
            self._store.fail_profile(work,"model_call_timeout")
        except (LayeredMemoryConflict,ModelWorkStopped):
            self._store.fail_profile(work,"input_changed")
        except ValueError:
            self._store.fail_profile(work,"profile_proposal_invalid")
        except Exception:
            self._store.fail_profile(work,"model_call_failed")
