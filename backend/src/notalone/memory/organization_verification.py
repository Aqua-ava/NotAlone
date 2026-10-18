"""L3逐项核验记录的确定性外壳；模型自报审计仍不是语义正确的证明。"""

from notalone.memory.organization_quality import content_digest


MAX_CLAIMS_PER_ENTRY = 8
SUBJECT_ROLES = frozenset({'app_user', 'contact', 'third_party', 'relationship', 'unknown'})
VALUE_CATEGORIES = frozenset({'static_fact', 'enduring_fact_or_preference', 'important_history',
                              'important_relationship', 'none'})
RELATIONSHIP_IMPACT_KINDS = frozenset({'ongoing_responsibility', 'shared_life_constraint',
                                      'important_shared_event', 'explicit_relationship_importance'})

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


def _bound_sources(sources, references, inputs, *, required):
    if (not isinstance(sources, list) or len(sources) > len(references)
            or required and not sources):
        raise ValueError('核验依据须绑定实际来源。')
    seen = set()
    for source in sources:
        if (not isinstance(source, dict) or set(source) != {'memory_id', 'revision', 'quote'}
                or not isinstance(source['quote'], str) or not source['quote'].strip()):
            raise ValueError('核验来源原文结构无效。')
        reference, = _references([{key: source[key] for key in ('memory_id', 'revision')}])
        if (reference not in references or reference in seen
                or source['quote'] not in inputs[reference]['text']):
            raise ValueError('核验来源须为条目直接引用的实际版本原文。')
        seen.add(reference)


def _relationship_impact(claim, references, inputs) -> bool:
    impact = claim['relationship_impact']
    required = claim['value_category'] != 'none' and (
        claim['subject_role'] in {'third_party', 'relationship'}
        or claim['value_category'] == 'important_relationship')
    if not required:
        if impact is not None:
            raise ValueError('不主张关系准入的命题须用空关系依据。')
        return True
    if impact is None:
        # 显式null表示未提供关系重要性依据，只否决准入，不补造证据。
        return False
    if (not isinstance(impact, dict) or set(impact) != {'kind', 'sources', 'basis'}
            or not isinstance(impact['kind'], str) or impact['kind'] not in RELATIONSHIP_IMPACT_KINDS
            or not isinstance(impact['basis'], str) or not 1 <= len(impact['basis'].strip()) <= 1000):
        raise ValueError('关系准入缺少独立的有界影响依据。')
    # 引文真实存在只证明绑定；它是否支持联系及重要性仍是模型语义判断。
    _bound_sources(impact['sources'], references, inputs, required=True)
    return True


def _claims_supported(claims: object, entry: dict, references, inputs) -> bool:
    """只机验覆盖/来源/类别合取，不证明命题原子性或关系重要性。"""
    if not isinstance(claims, list) or not 1 <= len(claims) <= MAX_CLAIMS_PER_ENTRY:
        raise ValueError('长期背景命题审计数量无效。')
    fields = {'text', 'sources', 'subject_role', 'subject_basis', 'supported',
              'value_category', 'relationship_impact', 'eligibility_basis'}
    parts, accepted = [], True
    for claim in claims:
        if (not isinstance(claim, dict) or set(claim) != fields
                or not isinstance(claim['text'], str) or not claim['text'].strip()
                or type(claim['supported']) is not bool
                or not isinstance(claim['value_category'], str) or claim['value_category'] not in VALUE_CATEGORIES
                or not isinstance(claim['subject_role'], str) or claim['subject_role'] not in SUBJECT_ROLES
                or any(not isinstance(claim[name], str) or not 1 <= len(claim[name].strip()) <= 1000
                       for name in ('subject_basis', 'eligibility_basis'))):
            raise ValueError('长期背景命题审计结构无效。')
        _bound_sources(claim['sources'], references, inputs, required=claim['supported'])
        impact_supported = _relationship_impact(claim, references, inputs)
        parts.append(claim['text'])
        accepted = (accepted and claim['supported'] and claim['value_category'] != 'none'
                    and claim['subject_role'] != 'unknown' and impact_supported)
    if ''.join(parts) != entry['text']:
        raise ValueError('命题原文须有序完整覆盖条目，不能遗漏或改写。')
    return accepted


def profile_verification_supported(result: dict, proposal: dict, memories: list[dict]) -> bool:
    """先验证完整覆盖，再合取逐项支持与准入；未知上下文不升级直接引用。"""
    entries, audits = proposal['entries'], result.get('entries')
    if (set(result) != {'supported', 'reasons', 'entries'} or not isinstance(audits, list)
            or len(audits) != len(entries)):
        raise ValueError('长期背景核验缺少完整逐条审计。')
    inputs = {(item['memory_id'], item['revision']): item for item in memories}
    accepted = result['supported']
    seen = set()
    fields = {'entry_index', 'entry_sha256', 'references', 'supported',
              'temporal_basis', 'temporal_references', 'basis', 'claims'}
    for audit in audits:
        if (not isinstance(audit, dict) or set(audit) != fields
                or type(audit['entry_index']) is not int or not 0 <= audit['entry_index'] < len(entries)
                or audit['entry_index'] in seen or type(audit['supported']) is not bool
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
        claims_supported = _claims_supported(audit['claims'], entry, references, inputs)
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
        accepted = accepted and audit['supported'] and temporal_supported and claims_supported
    return accepted
