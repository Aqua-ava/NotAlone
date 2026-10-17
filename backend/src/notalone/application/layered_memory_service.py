"""有限主题整理的管理入口；未知质量资格不会调用模型。"""

from copy import deepcopy
import json
import math
import inspect

from notalone.memory.layered import OrganizationBudget, OrganizationBudgetExhausted, LayeredMemoryConflict
from notalone.memory.scenario_validation import validate_proposal
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from notalone.application.organization_call import (
    bounded_organization_call, OrganizationCallTimeout, require_adapter_timeout_contract,
)


class LayeredMemoryService:
    def __init__(self, store, *, proposer=None, verifier=None, synthetic=False,
                 budget=None, model_priority=None, call_timeout_seconds=30.0, task_host=None, dispatcher=None):
        if (not isinstance(call_timeout_seconds, (int, float)) or isinstance(call_timeout_seconds, bool)
                or not math.isfinite(call_timeout_seconds) or not 0 < call_timeout_seconds <= 120):
            raise ValueError("整理调用必须有不超过120秒的有限等待。")
        self._call_timeout_seconds = call_timeout_seconds
        self._task_host = task_host
        self._change_feed = None
        self._dispatcher = dispatcher
        self._contract = "scenario-v3:synthetic-only:deadline-v1:coverage-v1"
        self._store, self._proposer, self._verifier = store, proposer, verifier
        if synthetic:
            store.require_synthetic_database()
            if proposer is None or verifier is None or proposer is verifier:
                raise ValueError("受控整理须分别注入提案和独立核验适配器。")
            require_adapter_timeout_contract(proposer, "propose", synthetic=True)
            require_adapter_timeout_contract(verifier, "verify", synthetic=True)
        self._scenario_context = bool(synthetic and
            'scenarios' in inspect.signature(proposer.propose).parameters and
            'scenarios' in inspect.signature(verifier.verify).parameters)
        if self._scenario_context:
            self._contract += ':scenario-context-v1'
        self._synthetic = synthetic
        self._budget = budget or OrganizationBudget()
        self._priority = model_priority or ModelPriorityControl()

    def attach_task_host(self, task_host):
        self._task_host=task_host

    def attach_dispatcher(self, dispatcher):
        if self._dispatcher is None:
            self._dispatcher=dispatcher

    def start_maintenance(self, owner_id):
        if self._synthetic and (self._task_host is not None or self._dispatcher is not None) and owner_id is not None and self._change_feed is None:
            def dispatch_due():
                scopes, delay = self._store.maintenance_due(owner_id)
                for scope in scopes:
                    task_id = self._store.enqueue_maintenance(scope, self._budget, self._contract)
                    if task_id is not None:
                        self._dispatch(scope, task_id)
                return delay
            self._change_feed = self._store.start_change_feed(owner_id, dispatch_due)

    def stop(self):
        self._priority.stop()
        if self._change_feed is not None:
            self._change_feed.stop()

    def resume_pending(self, owner_id):
        if not self._synthetic or self._task_host is None or owner_id is None:
            return
        for scope in self._store.pending_scopes(owner_id):
            task_id=self._store.pending(scope)
            if task_id is not None:
                self._dispatch(scope,task_id)

    def read(self, scope):
        if self._synthetic:
            task_id=self._store.pending(scope)
            if task_id is not None:
                self._dispatch(scope,task_id)
        state, entries, scenarios, job = self._store.read(scope)
        covered = state["covered_count"]
        return {"schema_version": 1, "scope_kind": "contact", "contact_id": str(scope.contact_id),
                "settings_generation": state["settings_generation"], "enabled": state["enabled"],
                "quality_status": "synthetic" if self._synthetic else "unknown",
                "status": state["status"], "eligible_count": len(entries), "covered_count": covered,
                "remaining_count": max(0, len(entries)-covered),
                "work_id": str(job['task_id']) if job else None,
                "work_revision": job['revision'] if job else 0,
                "current_batch": job['batch_number'] if job else 0,
                "model_calls_used": job['model_calls_used'] if job else 0,
                "model_call_limit": job['model_call_limit'] if job else 0,
                "organization_generation": state["organization_generation"],
                "updated_at": state["updated_at"].isoformat() if state["updated_at"] else None,
                "error_code": state["error_code"], "scenarios": scenarios,
                "maintenance_pending": state["dirty_revision"] > state["consumed_revision"],
                "scenario_mappings": state["scenario_mappings"],
                "purpose": "从本联系人已采纳且来历有效的记忆整理主题背景，供查看及后续受控回复使用。",
                "budget": self._budget.to_payload()}

    def command(self, scope, action, expected_generation, expected_work_revision=None):
        if action in {'pause','continue'}:
            if not self._synthetic:
                raise LayeredMemoryConflict('当前没有已获资格的覆盖工作。')
            state,_,_,_=self._store.read(scope)
            if state['settings_generation']!=expected_generation:
                raise LayeredMemoryConflict('范围设置已变化。')
        else:
            self._store.command(scope, action, expected_generation, quality_available=self._synthetic)
        if self._synthetic and action in {'enable','refresh','pause','continue'}:
            task_id, execute = self._store.enqueue(scope,self._budget,self._contract,action=action,revision=expected_work_revision)
            if execute:
                self._dispatch(scope,task_id)
        return self.read(scope)

    def _dispatch(self, scope, task_id):
        if self._task_host is not None:
            self._task_host.wake(owner_id=scope.owner_id,contact_id=scope.contact_id,task_id=task_id)
            return
        if self._dispatcher is None:
            raise RuntimeError('主题整理缺少已装配的任务调度器。')
        self._dispatcher(scope,task_id,runner=self,model_priority=self._priority)

    def run_batch(self, claim):
        from notalone.scopes import ContactScope
        if not self._synthetic:
            raise PermissionError('整理质量资格尚未获准。')
        scope=ContactScope(claim.owner_id,claim.contact_id)
        work = self._store.prepare(scope,self._budget,self._contract,claim, with_scenarios=self._scenario_context)
        if work is None:
            return 0
        try:
            raw = self._call(work, self._proposer, "propose", lambda deadline: self._proposer.propose(
                memories=deepcopy(work.memories), budget=self._budget, deadline=deadline,
                **({"scenarios": deepcopy(work.scenarios)} if self._scenario_context else {})))
            proposal = validate_proposal(raw, work.memories, self._budget, scenarios=work.scenarios)
            self._store.record_proposal(work, raw)
            # 核验实际接收全部记忆和完整提案，两者合计仍受单次输入上限约束。
            verification_input = {"memories": [item.to_payload() for item in work.memories], "proposal": raw}
            if self._scenario_context:
                verification_input["scenarios"] = work.scenarios
            if len(json.dumps(verification_input, ensure_ascii=False)) > self._budget.max_characters:
                self._store.fail(work, "verification_input_budget_exceeded")
                return 0
            supported = self._call(work, self._verifier, "verify", lambda deadline: self._verifier.verify(
                memories=deepcopy(work.memories), proposal=deepcopy(raw), deadline=deadline,
                **({"scenarios": deepcopy(work.scenarios)} if self._scenario_context else {})))
            if supported is not True:
                self._store.fail(work, "faithfulness_rejected")
                return 0
            self._store.publish(work, proposal, self._budget)
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

    def worker_failed(self, claim):
        self._store.worker_failed(claim)

    def _call(self, work, adapter, operation, call):
        require_adapter_timeout_contract(adapter, operation, synthetic=self._synthetic)
        def charged_call(deadline):
            deadline.check()
            self._store.charge(work)
            deadline.check()
            return call(deadline)
        return bounded_organization_call(charged_call, priority=self._priority,
            guard=lambda: self._store.check(work), timeout_seconds=self._call_timeout_seconds)

    def capture(self, scope):
        return self._store.capture(scope) if self._synthetic else None

    def read_scenario(self, snapshot, id, range):
        if not self._synthetic:
            raise PermissionError("整理读取质量资格尚未获准。")
        return self._store.read_scenario(snapshot, id, range)

    def validate(self, snapshot):
        return self._synthetic and self._store.validate(snapshot)

    def validate_in_transaction(self, connection, snapshot):
        """最终 writer 已持有相同范围锁时使用，不开启第二条连接。"""
        return self._synthetic and self._store.validate_in_transaction(connection, snapshot)
