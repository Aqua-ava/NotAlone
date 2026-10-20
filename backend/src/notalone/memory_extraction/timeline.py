"""关系核验之外的确定性替代约束，不以保存时刻认证现状。"""
from notalone.memory.models import AdoptionMethod
from notalone.memory.events import EventStage
from datetime import datetime
from notalone.memory_extraction.adjudication import AdjudicationAction


def replacement_supported(fact, similar, decision):
    evidence = decision.evolution
    if evidence is None or not evidence.source_supported or evidence.proof is None:
        return False
    ids = {identifier for identifier, _ in evidence.related_versions}
    targets = ({decision.replaced_memory_id} if decision.action is AdjudicationAction.UPDATE else set(decision.merged_memory_ids))
    if not targets or not targets <= ids:
        return False
    parents = [item.version for item in similar if item.memory_id in targets]
    if len(parents) != len(targets) or any(parent.adoption_method is not AdoptionMethod.AUTO for parent in parents):
        return False
    if decision.action is AdjudicationAction.MERGE:
        return evidence.kind == "supplement" and not evidence.claim_changed and not evidence.condition_changed
    if evidence.kind not in {"state_change", "error_correction"} or not evidence.claim_changed:
        return False
    previous = parents[0]
    # 条件改变本身不能撤销主张，二者必须经独立核验明确区分。
    old_conditions = tuple(item.text for item in previous.conditions.items) if previous.conditions else ()
    new_conditions = tuple(item.text for item in fact.conditions.items) if fact.conditions else ()
    if old_conditions != new_conditions and not evidence.condition_changed:
        return False
    old, new = previous.event, fact.event
    schedule_stages = {EventStage.PLANNED, EventStage.AGREED, EventStage.RESCHEDULED, EventStage.CANCELLED}
    schedule_revision = bool(old and new and old.source_current and new.source_current
                             and old.stage_verified and new.stage_verified
                             and old.stage in schedule_stages and new.stage in schedule_stages)
    if old is None and new is None or schedule_revision:
        snapshots = evidence.proof["sources"]["message_snapshots"]
        parent = next(item for item in evidence.proof["parents"] if item["memory_id"] == str(previous.memory_id))
        old_dates = [snapshots.get(identifier, {}).get("occurred_at") for identifier in parent.get("claim_source_ids", [])]
        new_dates = [snapshots.get(str(identifier), {}).get("occurred_at") for identifier in getattr(fact, "source_message_ids", getattr(fact, "source_ids", ()))]
        if (not old_dates or not new_dates or any(value is None for value in (*old_dates, *new_dates))
                or max(datetime.fromisoformat(value) for value in new_dates) <= max(datetime.fromisoformat(value) for value in old_dates)):
            return False
    if evidence.kind == "state_change" and not schedule_revision:
        if old is not None and new is not None:
            if not old.occurrence_verified or not new.occurrence_verified:
                return False
            # 可比较的真实发生区间优先于发言顺序；部分重叠不能排定新旧。
            if old.occurrence_start and new.occurrence_start:
                if new.occurrence_start < old.occurrence_start:
                    return False
                if new.occurrence_start != old.occurrence_start and old.occurrence_end and new.occurrence_start < old.occurrence_end:
                    return False
            elif old.occurrence_start != new.occurrence_start:
                return False
        elif old is not None or new is not None:
            return False
    return True
