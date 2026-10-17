"""有限主题整理的管理入口；未知质量资格不会调用模型。"""

from copy import deepcopy
import json
import math

from notalone.memory.layered import OrganizationBudget, LayeredMemoryConflict
from notalone.memory.scenario_validation import validate_proposal
from notalone.memory.profile_validation import validate_profile
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from notalone.application.organization_call import (
    bounded_organization_call, OrganizationCallTimeout, require_adapter_timeout_contract,
)


class LayeredMemoryService:
    def __init__(self, store, *, proposer=None, verifier=None, synthetic=False,
                 budget=None, model_priority=None, call_timeout_seconds=30.0,
                 profile_proposer=None, profile_verifier=None):
        if (not isinstance(call_timeout_seconds, (int, float)) or isinstance(call_timeout_seconds, bool)
                or not math.isfinite(call_timeout_seconds) or not 0 < call_timeout_seconds <= 120):
            raise ValueError("整理调用必须有不超过120秒的有限等待。")
        self._call_timeout_seconds = call_timeout_seconds
        self._store, self._proposer, self._verifier = store, proposer, verifier
        if synthetic:
            store.require_synthetic_database()
            if proposer is None or verifier is None or proposer is verifier:
                raise ValueError("受控整理须分别注入提案和独立核验适配器。")
            require_adapter_timeout_contract(proposer, "propose", synthetic=True)
            require_adapter_timeout_contract(verifier, "verify", synthetic=True)
        self._profile_proposer, self._profile_verifier = profile_proposer, profile_verifier
        if (profile_proposer is None) != (profile_verifier is None):
            raise ValueError("长期背景须同时装配独立提案和核验适配器。")
        if profile_proposer is not None:
            if not synthetic or profile_proposer is profile_verifier:
                raise ValueError("长期背景尚仅开放独立受控合成验证。")
            require_adapter_timeout_contract(profile_proposer, "propose", synthetic=True)
            require_adapter_timeout_contract(profile_verifier, "verify", synthetic=True)
        self._synthetic = synthetic
        self._budget = budget or OrganizationBudget(max_model_calls=4 if profile_proposer else 2)
        if profile_proposer and self._budget.max_model_calls != 4:
            raise ValueError("长期背景装配要求显式四步有限预算。")
        self._priority = model_priority or ModelPriorityControl()

    def read(self, scope):
        state, entries, scenarios, profile = self._store.read(scope)
        covered = state["covered_count"]
        return {"schema_version": 2, "scope_kind": "contact", "contact_id": str(scope.contact_id),
                "settings_generation": state["settings_generation"], "enabled": state["enabled"],
                "quality_status": "synthetic" if self._synthetic else "unknown",
                "status": state["status"], "eligible_count": len(entries), "covered_count": covered,
                "remaining_count": max(0, len(entries)-covered),
                "organization_generation": state["organization_generation"],
                "updated_at": state["updated_at"].isoformat() if state["updated_at"] else None,
                "error_code": state["error_code"], "scenarios": scenarios, "profile": profile,
                "purpose": "从本联系人已采纳且来历有效的记忆整理主题背景，供查看及后续受控回复使用。",
                "budget": self._budget.to_payload()}

    def command(self, scope, action, expected_generation):
        self._store.command(scope, action, expected_generation, quality_available=self._synthetic)
        if self._synthetic and action in {"enable", "refresh"}:
            self.organize(scope)
        return self.read(scope)

    def organize(self, scope):
        """手动刷新与后续统一变化通知共用的有限流程；停用范围由Store拒绝。"""
        self._organize_scenarios(scope)
        if self._profile_proposer:
            self._organize_profile(scope)

    def _organize_scenarios(self, scope):
        work = self._store.prepare(scope, self._budget, "scenario-v2:synthetic-only:deadline-v1")
        if work is None:
            return
        try:
            raw = self._call(work, self._proposer, "propose", lambda deadline: self._proposer.propose(
                memories=deepcopy(work.memories), budget=self._budget, deadline=deadline))
            proposal = validate_proposal(raw, work.memories, self._budget)
            self._store.record_proposal(work, raw)
            # 核验实际接收全部记忆和完整提案，两者合计仍受单次输入上限约束。
            verification_input = {"memories": [item.to_payload() for item in work.memories], "proposal": raw}
            if len(json.dumps(verification_input, ensure_ascii=False)) > self._budget.max_characters:
                self._store.fail(work, "verification_input_budget_exceeded")
                return
            supported = self._call(work, self._verifier, "verify", lambda deadline: self._verifier.verify(
                memories=deepcopy(work.memories), proposal=deepcopy(raw), deadline=deadline))
            if supported is not True:
                self._store.fail(work, "faithfulness_rejected")
                return
            self._store.publish(work, proposal)
        except OrganizationCallTimeout:
            self._store.fail(work, "model_call_timeout")
        except (LayeredMemoryConflict, ModelWorkStopped):
            self._store.fail(work, "input_changed")
        except ValueError:
            self._store.fail(work, "proposal_invalid")
        except Exception:
            self._store.fail(work, "model_call_failed")

    def _call(self, work, adapter, operation, call):
        require_adapter_timeout_contract(adapter, operation, synthetic=self._synthetic)
        return bounded_organization_call(call, priority=self._priority,
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

    def withdraw_profile(self, scope, settings_generation, organization_generation, profile_version_id):
        self._store.withdraw_profile(scope,settings_generation,organization_generation,profile_version_id)
        return self.read(scope)

    def _organize_profile(self, scope):
        work = self._store.prepare_profile(scope,self._budget,"profile-v1:synthetic-only:deadline-v1",
            lease_seconds=self._call_timeout_seconds * 2 + 5)
        if work is None:
            return
        try:
            raw = self._profile_call(work,self._profile_proposer,"propose",lambda deadline: self._profile_proposer.propose(
                scenarios=deepcopy(work.scenarios),memories=deepcopy(work.memories),budget=self._budget,deadline=deadline))
            proposal = validate_profile(raw,work.memories,self._budget)
            self._store.record_profile_proposal(work,raw)
            payload = {"scenarios": list(work.scenarios),"memories": [item.to_payload() for item in work.memories],"proposal": raw}
            if len(json.dumps(payload,ensure_ascii=False)) > self._budget.max_characters:
                self._store.fail_profile(work,"profile_verification_input_budget_exceeded")
                return
            supported = self._profile_call(work,self._profile_verifier,"verify",lambda deadline: self._profile_verifier.verify(
                scenarios=deepcopy(work.scenarios),memories=deepcopy(work.memories),proposal=deepcopy(raw),deadline=deadline))
            if supported is not True:
                self._store.fail_profile(work,"profile_faithfulness_rejected")
                return
            self._store.publish_profile(work,proposal)
        except OrganizationCallTimeout:
            self._store.fail_profile(work,"model_call_timeout")
        except (LayeredMemoryConflict,ModelWorkStopped):
            self._store.fail_profile(work,"input_changed")
        except ValueError:
            self._store.fail_profile(work,"profile_proposal_invalid")
        except Exception:
            self._store.fail_profile(work,"model_call_failed")

    def _profile_call(self, work, adapter, operation, call):
        require_adapter_timeout_contract(adapter,operation,synthetic=self._synthetic)
        return bounded_organization_call(call,priority=self._priority,guard=lambda: self._store.check_profile(work),
            timeout_seconds=self._call_timeout_seconds)
