"""本人整理的外发白名单；私有来源证明始终留在仓储复验。"""
from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True, repr=False)
class OwnerOrganizationInput:
    memory_id: UUID
    revision: int
    text: str
    timing: dict

    def to_payload(self):
        return {'memory_id': str(self.memory_id), 'revision': self.revision,
                'text': self.text, 'timing': self.timing}


def owner_temporal_payload(timing, event, valid_at, invalid_at):
    """本人外发时间保留含义，不携带原消息位置。"""
    return {**{key: timing.get(key) for key in ('recorded_at', 'source_started_at',
        'source_ended_at', 'source_time_complete', 'current_status')},
        'valid_at': valid_at, 'invalid_at': invalid_at,
        'event': ({key: event[key] for key in ('stage', 'occurrence_start',
            'occurrence_end', 'stage_verified', 'occurrence_verified', 'occurrence_precision', 'occurrence_expression') if key in event} if event else None)}


def owner_model_memories(memories):
    return tuple(OwnerOrganizationInput(item.memory_id, item.revision, item.text,
        owner_temporal_payload(item.timing, item.event, item.valid_at, item.invalid_at))
        for item in memories)


def owner_model_scenarios(scenarios):
    # 主题正文及必要时间可进入L3；来源定位不外发，旧引用不从当前资料回填。
    return tuple({key: item[key] for key in ('scenario_id', 'version_id', 'title', 'hint') if key in item}
        | {'paragraphs': [{**{key: paragraph[key] for key in ('kind', 'section', 'basis', 'uncertainty') if key in paragraph}, 'text': paragraph['text'], 'references': [
            {**{key: ref[key] for key in ('memory_id', 'revision')},
             'timing': owner_temporal_payload(ref.get('timing', {}), ref.get('event'),
                                               ref.get('valid_at'), ref.get('invalid_at'))}
            for ref in paragraph['references']]}
            for paragraph in item['paragraphs']]} for item in scenarios)


def organization_model_memories(scope, memories):
    """两类scope共享唯一投影入口；联系人保留既有合法来源/事件合同。"""
    return owner_model_memories(memories) if scope.contact_id is None else memories


def organization_model_scenarios(scope, scenarios):
    return owner_model_scenarios(scenarios) if scope.contact_id is None else scenarios
