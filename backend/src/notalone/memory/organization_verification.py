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

SOURCE_SUBJECT_POLICY = '''
先逐条审计每个claim.sources完整quote的主体，再判断聚合claim，不能用“联系人背景”代替原文主体。
每个claim还必须输出source_subjects数组，按sources的(memory_id,revision)逐一完整对应且不重复：
{"memory_id":"实际ID","revision":1,"subject_roles":["contact"],"basis":"该来源完整quote的实际主体依据"}。
subject_roles为1至5个不重复主体类别，沿用subject_role枚举；一条引文涉及不同类别须全部列出，unknown不能准入。
聚合subject_role为app_user/contact/third_party时，每条来源的subject_roles必须恰为该单一类别；不同主体不可合成联系人事实，须拆分命题或否决。
relationship可使用多主体来源，但仍逐命题核验真实联系及重要影响原文；仅给附带兴趣改relationship标签不能准入。
source_subjects继承对应sources的完整quote，不另选更短片段。sources为空且supported=false时source_subjects也为空；不得用聚合主体自动补逐来源审计。
'''


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


def profile_claims_supported(claims: object, entry: dict, references, inputs) -> bool:
    """机验覆盖、来源角色一致和准入合取；角色语义及关系重要性仍须独立核验。"""
    if not isinstance(claims, list) or not 1 <= len(claims) <= MAX_CLAIMS_PER_ENTRY:
        raise ValueError('长期背景命题审计数量无效。')
    fields = {'text', 'sources', 'source_subjects', 'subject_role', 'subject_basis', 'supported',
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
        subjects_supported = _source_subjects_supported(claim)
        impact_supported = _relationship_impact(claim, references, inputs)
        parts.append(claim['text'])
        accepted = (accepted and claim['supported'] and claim['value_category'] != 'none'
                    and claim['subject_role'] != 'unknown' and subjects_supported and impact_supported)
    if ''.join(parts) != entry['text']:
        raise ValueError('命题原文须有序完整覆盖条目，不能遗漏或改写。')
    return accepted


def _source_subjects_supported(claim):
    audits = claim['source_subjects']
    expected = {(source['memory_id'], source['revision']) for source in claim['sources']}
    if not isinstance(audits, list) or len(audits) != len(expected):
        raise ValueError('逐来源主体审计须完整覆盖命题实际引文。')
    seen, accepted = set(), True
    for audit in audits:
        if (not isinstance(audit, dict) or set(audit) != {'memory_id', 'revision', 'subject_roles', 'basis'}
                or not isinstance(audit['basis'], str) or not 1 <= len(audit['basis'].strip()) <= 1000):
            raise ValueError('逐来源主体审计结构无效。')
        reference, = _references([{key: audit[key] for key in ('memory_id', 'revision')}])
        if reference not in expected or reference in seen:
            raise ValueError('逐来源主体审计版本须与实际引文逐一对应。')
        roles = audit['subject_roles']
        if (not isinstance(roles, list) or not 1 <= len(roles) <= len(SUBJECT_ROLES)
                or any(not isinstance(role, str) or role not in SUBJECT_ROLES for role in roles)
                or len(set(roles)) != len(roles)):
            raise ValueError('逐来源主体类别须有界、已知且不重复。')
        seen.add(reference)
        accepted = accepted and 'unknown' not in roles and (
            claim['subject_role'] == 'relationship' or set(roles) == {claim['subject_role']})
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
        claims_supported = profile_claims_supported(audit['claims'], entry, references, inputs)
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


def profile_verification_items(result, proposal, memories):
    """在完整响应中按索引单独审计，不把相邻失败传播给合法条目。"""
    audits = result.get('entries') if isinstance(result, dict) else None
    if (not isinstance(result, dict) or set(result) != {'supported', 'reasons', 'entries'}
            or type(result['supported']) is not bool or not isinstance(result['reasons'], list)
            or not isinstance(audits, list)):
        raise ValueError('长期背景核验顶层结构无效。')
    accepted, rejected = [], []
    for index, entry in enumerate(proposal['entries']):
        matches = [audit for audit in audits if isinstance(audit, dict)
                   and type(audit.get('entry_index')) is int and audit['entry_index'] == index]
        try:
            if len(matches) != 1:
                raise ValueError('条目审计缺失或重复。')
            audit = {**matches[0], 'entry_index': 0}
            valid = profile_verification_supported(
                {'supported': True, 'reasons': [], 'entries': [audit]}, {'entries': [entry]}, memories)
            if not valid:
                raise ValueError('条目来源、时间或长期价值未获支持。')
        except (ValueError, TypeError, KeyError) as error:
            rejected.append({'index': index, 'reason': str(error)})
        else:
            accepted.append(index)
    return {'accepted_indices': accepted, 'rejected': rejected}
