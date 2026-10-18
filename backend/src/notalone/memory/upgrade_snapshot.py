"""升级暂存结果的版本化表示；恢复不查询当前资料补造旧证明。"""

from datetime import datetime
import hashlib
import json
from uuid import UUID

from notalone.memory.dimension_evidence import DimensionEvidence
from notalone.memory.events import MemoryEvent
from notalone.memory.models import MemoryCategory, MemoryTopic, SourceDependencyMode
from notalone.memory.timing import MemoryTiming
from notalone.memory_extraction.flow import ExtractionOutcome
from notalone.memory_extraction.models import ExtractedFact, FactSubject, SpeechAct, AssertionStatus, FigurativeType
from notalone.memory_extraction.adjudication import similarity
from notalone.memory_trace.context import snapshot


def upgrade_digest(value) -> str:
    return hashlib.sha256(json.dumps(snapshot(value), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def outcome_payload(outcome: ExtractionOutcome) -> dict:
    if outcome.failure_reason is not None:
        raise ValueError('失败结果不能作为可应用升级快照。')
    return {'version': 2, 'accepted': [_fact_payload(fact) for fact in outcome.accepted],
            'candidate_trace_ids': [str(identifier) for identifier in outcome.candidate_trace_ids],
            'rejected_count': outcome.rejected_count, 'extraction_completed': outcome.extraction_completed}


def _fact_payload(fact: ExtractedFact) -> dict:
    return {**snapshot(fact), 'timing': fact.timing.to_payload(),
            'dimension_evidence': fact.dimension_evidence.to_payload() if fact.dimension_evidence else None,
            'event': fact.event.to_payload() if fact.event else None}


def restore_outcome(value: dict) -> ExtractionOutcome:
    required={'version', 'accepted', 'rejected_count', 'extraction_completed'}
    if (not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] not in (1,2)
            or set(value) != (required|{'candidate_trace_ids'} if value['version']==2 else required)
            or not isinstance(value['accepted'], list) or len(value['accepted']) > 64
            or type(value['rejected_count']) is not int or value['rejected_count'] < 0
            or type(value['extraction_completed']) is not bool):
        raise ValueError('升级提取快照版本或结构无效。')
    identifiers=value.get('candidate_trace_ids',[])
    if (not isinstance(identifiers,list) or len(identifiers) not in (0,len(value['accepted']))
            or any(not isinstance(item,str) for item in identifiers) or len(set(identifiers))!=len(identifiers)):
        raise ValueError('升级候选追踪关联无效。')
    trace_ids=tuple(UUID(item) for item in identifiers)
    facts = []
    for row in value['accepted']:
        facts.append(ExtractedFact(
            text=row['text'], category=MemoryCategory(row['category']), subject=FactSubject(row['subject']),
            topic=MemoryTopic(row['topic']), source_message_ids=tuple(UUID(item) for item in row['source_message_ids']),
            confidence=row['confidence'], risk_flags=tuple(row['risk_flags']),
            valid_at=_time(row['valid_at']), invalid_at=_time(row['invalid_at']),
            speech_act=SpeechAct(row['speech_act']), assertion_status=AssertionStatus(row['assertion_status']),
            figurative_type=FigurativeType(row['figurative_type']), alternatives=tuple(row['alternatives']),
            interpretation_reason=row['interpretation_reason'], timing=MemoryTiming.from_payload(row['timing']),
            dimension_evidence=DimensionEvidence.from_payload(row['dimension_evidence']) if row.get('dimension_evidence') else None,
            event=MemoryEvent.from_payload(row.get('event')),
            source_dependency_mode=SourceDependencyMode(row.get('source_dependency_mode', 'any')),
            requires_all_sources=row.get('requires_all_sources', False),
        ))
    return ExtractionOutcome(accepted=tuple(facts), rejected_count=value['rejected_count'],
                             extraction_completed=value['extraction_completed'],candidate_trace_ids=trace_ids)


def _time(value):
    return None if value is None else datetime.fromisoformat(value)


def comparison_payload(compared) -> dict:
    """比较只显示真实旧记录与新提案；完整新证明另存为暂存结果。"""
    actions = []
    for action in compared.actions:
        candidate, previous = action.candidate, action.previous
        actions.append({'kind': action.kind, 'candidate_id': str(candidate.candidate_id),
            'result_memory_id': str(action.result_memory_id) if action.result_memory_id else None,
            'new': {'text': candidate.text, 'category': candidate.category.value, 'topic': candidate.topic.value,
                    'subject': candidate.subject.value, 'source_ids': [str(item) for item in candidate.source_ids],
                    'source_dependency_mode': candidate.source_dependency_mode.value,
                    'requires_all_sources': candidate.requires_all_sources,
                    'timing': candidate.timing.to_payload(), 'event': candidate.event.to_payload() if candidate.event else None,
                    'correction_review': [item.to_payload() for item in candidate.correction_review],
                    'has_new_proof': candidate.dimension_evidence is not None},
            'previous': _memory_payload(previous) if previous else None,
        })
    relevant = [item for item in compared.current if not compared.actions or any(
        item.category == action.candidate.category and item.topic == action.candidate.topic for action in compared.actions)]
    relevant.sort(key=lambda item: (-max((similarity(item.text, action.candidate.text) for action in compared.actions), default=0),
                                   str(item.memory_id)))
    return {'version': 1, 'actions': actions, 'stats': snapshot(compared.stats),
            'current': [_memory_payload(item) for item in relevant[:8]], 'current_count': len(relevant)}


def _memory_payload(memory):
    return {'memory_id': str(memory.memory_id), 'text': memory.text, 'revision': memory.revision,
            'scope_kind': 'contact' if hasattr(memory, 'scope') else 'owner',
            'adoption_method': memory.adoption_method.value, 'status': memory.status.value,
            'category': memory.category.value, 'topic': memory.topic.value,
            'source_ids': [str(item) for item in memory.source_ids],
            'source_dependency_mode': memory.source_dependency_mode.value,
            'requires_all_sources': memory.requires_all_sources,
            'timing': memory.timing.to_payload(), 'event': memory.event.to_payload() if memory.event else None,
            'proof_kind': 'version_receipt' if memory.version_evidence else 'unknown'}
