"""待确认候选的业务身份；评分或窗口证明变化不产生第二条候选。"""

from notalone.memory.models import MemoryCandidate
from notalone.memory.events import MemoryEvent, same_verified_event_claim


def _same_event_meaning(left: MemoryEvent | None, right: MemoryEvent | None) -> bool:
    # 未知不能证明另一主张；结构或证明刷新本身不产生新待确认。
    if left is None or right is None or not left.source_current or not right.source_current:
        return True
    return not (
        left.stage_verified and right.stage_verified and left.stage != right.stage
        or left.occurrence_verified and right.occurrence_verified and (
            left.occurrence_start != right.occurrence_start
            or left.occurrence_end != right.occurrence_end
        )
    )


def same_pending_identity(left: MemoryCandidate, right: MemoryCandidate) -> bool:
    # 时间边界进一步区分同一消息中的两次事件，不把评分当事件身份。
    return (
        left.scope == right.scope and left.subject is right.subject
        and left.category is right.category and left.topic is right.topic
        and "".join(left.text.split()).lower() == "".join(right.text.split()).lower()
        and (set(left.source_ids) == set(right.source_ids)
             or bool(set(left.source_ids) & set(right.source_ids))
             and same_verified_event_claim(left.event, right.event))
        and left.valid_at == right.valid_at and left.invalid_at == right.invalid_at
        and _same_event_meaning(left.event, right.event)
    )
