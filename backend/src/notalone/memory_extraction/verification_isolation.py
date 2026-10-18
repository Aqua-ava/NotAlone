"""一次批量来源核验中的条目隔离；缺失或重复索引不能签发通过。"""

from notalone.memory_extraction.errors import ExtractionInvalidOutputError
from notalone.memory_extraction.verification import validate_source_verification, SourceVerificationMode
from notalone.memory_trace.context import record


def isolate_verification_payloads(payloads, *, window, facts, mode):
    if not isinstance(payloads, tuple):
        raise ExtractionInvalidOutputError('来源核验没有可解析的条目数组。')
    # 历史proof协议的摘要绑定原始索引，不改写为新协议。
    if mode != SourceVerificationMode.LEGACY_V4:
        validate_source_verification(payloads, window=window, facts=facts, mode=mode)
        return payloads
    result = []
    for index, fact in enumerate(facts):
        matches = [item for item in payloads if isinstance(item, dict)
                   and type(item.get('candidate_index')) is int and item['candidate_index'] == index]
        try:
            if len(matches) != 1:
                raise ExtractionInvalidOutputError('条目核验缺失或重复。')
            item = matches[0]
            validate_source_verification(({**item, 'candidate_index': 0},), window=window, facts=(fact,), mode=mode)
            result.append(item)
        except ExtractionInvalidOutputError:
            record('verification_item_rejected', {'candidate_index': index, 'reason': 'invalid_item_contract'})
            result.append({'candidate_index': index, 'verdict': 'unsupported',
                'issues': ['insufficient_evidence'], 'evidence': []})
    return tuple(result)
