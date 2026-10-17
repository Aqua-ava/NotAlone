"""有限主题整理的管理入口；未知质量资格不会调用模型。"""

from copy import deepcopy
import math

from notalone.memory.layered import OrganizationBudget, LayeredMemoryConflict
from notalone.memory.scenario_validation import validate_proposal
from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped
from notalone.application.organization_call import bounded_organization_call, OrganizationCallTimeout


class LayeredMemoryService:
    def __init__(self, store, *, proposer=None, verifier=None, synthetic=False,
                 budget=None, model_priority=None, call_timeout_seconds=30.0):
        if (not isinstance(call_timeout_seconds, (int, float)) or isinstance(call_timeout_seconds, bool)
                or not math.isfinite(call_timeout_seconds) or not 0 < call_timeout_seconds <= 120):
            raise ValueError("整理调用必须有不超过120秒的有限等待。")
        self._call_timeout_seconds = call_timeout_seconds
        self._store, self._proposer, self._verifier = store, proposer, verifier
        if synthetic:
            store.require_synthetic_database()
            if proposer is None or verifier is None or proposer is verifier:
                raise ValueError("受控整理须分别注入提案和独立核验适配器。")
        self._synthetic = synthetic
        self._budget = budget or OrganizationBudget()
        self._priority = model_priority or ModelPriorityControl()

    def read(self, scope):
        state, entries, scenarios = self._store.read(scope)
        covered = state["covered_count"]
        return {"schema_version": 1, "scope_kind": "contact", "contact_id": str(scope.contact_id),
                "settings_generation": state["settings_generation"], "enabled": state["enabled"],
                "quality_status": "synthetic" if self._synthetic else "unknown",
                "status": state["status"], "eligible_count": len(entries), "covered_count": covered,
                "remaining_count": max(0, len(entries)-covered),
                "organization_generation": state["organization_generation"],
                "updated_at": state["updated_at"].isoformat() if state["updated_at"] else None,
                "error_code": state["error_code"], "scenarios": scenarios,
                "purpose": "从本联系人已采纳且来历有效的记忆整理主题背景，供查看及后续受控回复使用。",
                "budget": self._budget.to_payload()}

    def command(self, scope, action, expected_generation):
        self._store.command(scope, action, expected_generation, quality_available=self._synthetic)
        if self._synthetic and action in {"enable", "refresh"}:
            self._organize(scope)
        return self.read(scope)

    def _organize(self, scope):
        work = self._store.prepare(scope, self._budget, "scenario-v1:synthetic-only")
        if work is None:
            return
        try:
            raw = self._call(work, lambda: self._proposer.propose(
                memories=deepcopy(work.memories), budget=self._budget))
            proposal = validate_proposal(raw, work.memories, self._budget)
            self._store.record_proposal(work, raw)
            supported = self._call(work, lambda: self._verifier.verify(
                memories=deepcopy(work.memories), proposal=deepcopy(raw)))
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

    def _call(self, work, call):
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
