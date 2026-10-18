"""L3逐项核验记录的确定性外壳；模型自报审计仍不是语义正确的证明。"""

from notalone.memory.organization_quality import content_digest


TEMPORAL_BASES = frozenset({
    'static_fact', 'historical', 'current_verified', 'current_unverified', 'unknown',
})


def profile_verification_targets(proposal: dict) -> list[dict]:
    return [{'entry_index': index, 'entry_sha256': content_digest(entry)}
            for index, entry in enumerate(proposal['entries'])]


def _references(value: object) -> frozenset[tuple[str, int]]:
    if not isinstance(value, list):
        raise ValueError('核验引用须为逐条版本列表。')
    result = set()
    for item in value:
        if (not isinstance(item, dict) or set(item) != {'memory_id', 'revision'}
                or not isinstance(item['memory_id'], str) or type(item['revision']) is not int
                or item['revision'] < 1):
            raise ValueError('核验引用结构无效。')
        pair = (item['memory_id'], item['revision'])
        if pair in result:
            raise ValueError('核验引用不能重复。')
        result.add(pair)
    return frozenset(result)


def profile_verification_supported(result: dict, proposal: dict, memories: list[dict]) -> bool:
    """先验证完整覆盖，再合取逐项支持与准入；未知上下文不升级直接引用。"""
    entries, audits = proposal['entries'], result.get('entries')
    if (set(result) != {'supported', 'reasons', 'entries'} or not isinstance(audits, list)
            or len(audits) != len(entries)):
        raise ValueError('长期背景核验缺少完整逐条审计。')
    inputs = {(item['memory_id'], item['revision']): item for item in memories}
    accepted = result['supported']
    seen = set()
    fields = {'entry_index', 'entry_sha256', 'references', 'supported', 'profile_eligible',
              'temporal_basis', 'temporal_references', 'basis'}
    for audit in audits:
        if (not isinstance(audit, dict) or set(audit) != fields
                or type(audit['entry_index']) is not int or not 0 <= audit['entry_index'] < len(entries)
                or audit['entry_index'] in seen or type(audit['supported']) is not bool
                or type(audit['profile_eligible']) is not bool
                or not isinstance(audit['temporal_basis'], str) or audit['temporal_basis'] not in TEMPORAL_BASES
                or not isinstance(audit['basis'], str) or not 1 <= len(audit['basis'].strip()) <= 1000):
            raise ValueError('长期背景逐条核验结构无效。')
        seen.add(audit['entry_index'])
        entry = entries[audit['entry_index']]
        references = _references(entry['references'])
        temporal_references = _references(audit['temporal_references'])
        if (audit['entry_sha256'] != content_digest(entry) or _references(audit['references']) != references
                or not references or not references <= inputs.keys() or not temporal_references <= references):
            raise ValueError('长期背景核验未绑定本次条目及直接版本引用。')
        basis = audit['temporal_basis']
        if basis == 'current_verified':
            # 只检查审计明确指向的现状支持；其他上下文未知不抵销有效当前依据。
            temporal_supported = bool(temporal_references) and all(
                (inputs[reference].get('timing') or {}).get('current_status') == 'current_verified'
                for reference in temporal_references)
        else:
            if temporal_references:
                raise ValueError('非现状核实依据不能冒用当前核实引用。')
            temporal_supported = (basis == 'static_fact'
                or basis == 'historical' and entry['temporal_status'] == 'historical'
                or basis == 'current_unverified' and entry['temporal_status'] == 'uncertain')
        accepted = accepted and audit['supported'] and audit['profile_eligible'] and temporal_supported
    return accepted
