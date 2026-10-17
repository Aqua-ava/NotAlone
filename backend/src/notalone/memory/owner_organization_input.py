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


def owner_model_memories(memories):
    return tuple(OwnerOrganizationInput(item.memory_id, item.revision, item.text,
        {**{key: item.timing[key] for key in ('recorded_at', 'source_started_at',
            'source_ended_at', 'source_time_complete', 'current_status')},
         'valid_at': item.valid_at, 'invalid_at': item.invalid_at,
         'event': ({key: item.event[key] for key in ('stage', 'occurrence_start',
             'occurrence_end', 'stage_verified', 'occurrence_verified') if key in item.event} if item.event else None)})
        for item in memories)


def owner_model_scenarios(scenarios):
    # 主题正文及必要版本入口可进入L3；引用只带底层ID/版本，来源定位不外发。
    return tuple({key: item[key] for key in ('scenario_id', 'version_id', 'title', 'hint') if key in item}
        | {'paragraphs': [{'text': paragraph['text'], 'references': [
            {key: ref[key] for key in ('memory_id', 'revision')} for ref in paragraph['references']]}
            for paragraph in item['paragraphs']]} for item in scenarios)
