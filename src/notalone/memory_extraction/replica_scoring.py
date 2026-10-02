"""汇总盲化来源复核；语义由独立复核提供，日期按冻结 oracle 单独计算。"""

from __future__ import annotations

from datetime import datetime
from typing import Any


def _time_matches(actual: Any, oracle: dict[str, Any]) -> bool:
    if oracle['mode'] == 'ignore':
        return True
    if oracle['mode'] == 'must_null':
        return actual is None
    for expected in oracle['allowed']:
        if actual is None or expected is None:
            if actual is expected:
                return True
        else:
            try:
                value = datetime.fromisoformat(str(actual))
                allowed = datetime.fromisoformat(expected)
                if value.tzinfo is not None and allowed.tzinfo is not None and value == allowed:
                    return True
            except ValueError:
                pass
    return False


def _candidate_key(fact: dict[str, Any]) -> tuple[str, ...]:
    return tuple(str(fact.get(key)) for key in (
        'text', 'subject', 'source_message_ids', 'valid_at', 'invalid_at',
        'speech_act', 'assertion_status', 'figurative_type',
    ))


def score_review(record: dict[str, Any], review: dict[str, Any]) -> dict[str, Any]:
    """遗漏 gold 或额外错误均使场景失败；候选去向不充当语义裁判。"""
    gold = {claim['claim_id']: claim for claim in record['source']['gold']}
    result: dict[str, Any] = {}
    for phase in ('raw', 'guarded'):
        output = record['outputs'][phase]
        if output is None:
            result[phase] = None
            continue
        candidates = review[phase]['candidates']
        facts = output['facts']
        if (len(candidates) != len(facts)
                or {item['index'] for item in candidates} != set(range(len(facts)))):
            raise ValueError('独立复核必须逐候选一对一，不能遗漏错误候选。')
        covered: set[str] = set()
        time_covered: set[str] = set()
        bad, unsupported_auto, subject_errors = 0, 0, 0
        time_correct, time_total, destination_errors = 0, 0, 0
        for candidate in candidates:
            if not set(candidate['claim_ids']) <= set(gold):
                raise ValueError('独立复核引用了不存在的 gold。')
            if type(candidate['faithful']) is not bool or type(candidate['subject_error']) is not bool:
                raise ValueError('独立复核的布尔判断无效。')
            fact = facts[candidate['index']]
            if not candidate['faithful']:
                bad += 1
                unsupported_auto += fact.get('destination') == 'auto'
            subject_errors += candidate['subject_error']
            for claim_id in candidate['claim_ids']:
                claim = gold[claim_id]
                if candidate['faithful']:
                    covered.add(claim_id)
                matches = []
                for field in ('valid_at', 'invalid_at'):
                    if claim[field]['mode'] != 'ignore':
                        time_total += 1
                        matched = _time_matches(fact.get(field), claim[field])
                        time_correct += matched
                        matches.append(matched)
                if candidate['faithful'] and all(matches):
                    time_covered.add(claim_id)
                destination_errors += fact.get('destination') not in claim['allowed_destinations']
            if not gold and fact.get('destination') != 'none':
                destination_errors += 1
        # 一条 gold 可以由多条忠实、相互独立的分句共同表达；复核需对整个输出
        # 判断完整覆盖，不能以某个子句有根据代替同一主张的限定完整。
        declared = review[phase].get('covered_claim_ids')
        if (not isinstance(declared, list) or len(set(declared)) != len(declared)
                or not set(declared) <= covered):
            raise ValueError('整体覆盖必须显式引用唯一且有忠实候选承载的 gold。')
        covered = set(declared)
        time_covered &= covered
        result[phase] = {
            'semantic_complete': (covered == set(gold) and bad == 0
                                  and subject_errors == 0 and not output['failure']),
            'claims_covered': len(covered), 'claims_required': len(gold),
            'unfaithful_candidates': bad, 'candidate_count': len(facts),
            'unsupported_auto': unsupported_auto, 'subject_errors': subject_errors,
            'time_correct_fields': time_correct, 'time_checked_fields': time_total,
            'complete_with_time': (time_covered == set(gold) and time_correct == time_total
                                   and bad == 0 and subject_errors == 0 and not output['failure']),
            'destination_errors': destination_errors, 'runtime_failure': output['failure'],
        }
    guarded = record['outputs']['guarded']
    guarded_keys = set() if guarded is None else {
        _candidate_key(fact) for fact in guarded['facts']
    }
    result['correct_candidates_dropped'] = sum(
        item['faithful'] and not item['subject_error'] and bool(item['claim_ids'])
        and all(_time_matches(
            record['outputs']['raw']['facts'][item['index']].get(field), gold[claim_id][field],
        ) for claim_id in item['claim_ids'] for field in ('valid_at', 'invalid_at'))
        and _candidate_key(record['outputs']['raw']['facts'][item['index']]) not in guarded_keys
        for item in review['raw']['candidates']
    ) if guarded is not None and not guarded['failure'] else 0
    return result
