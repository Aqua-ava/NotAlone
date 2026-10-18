"""人工支持与逐项输出审阅绑定实际hash；Agent审阅永不改称human。"""

from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_quality_report import SEMANTIC_DIMENSIONS, output_items
from notalone.memory.layered import LayeredMemoryConflict


def reviewer(value):
    if (not isinstance(value, dict) or set(value) != {'kind', 'name'} or value['kind'] not in {'human', 'agent'}
            or not isinstance(value['name'], str) or not 1 <= len(value['name'].strip()) <= 120):
        raise ValueError('须记录实际审阅者类型与身份。')


def decision(value):
    if value not in {'approved', 'rejected'}:
        raise ValueError('须明确审阅决定。')


def references(value, row):
    allowed = {(item['memory_id'], item['revision']) for item in row['model_input']['memories']}
    if (not isinstance(value, list) or not value or any(not isinstance(ref, dict)
            or set(ref) != {'memory_id', 'revision'} or (ref['memory_id'], ref['revision']) not in allowed for ref in value)):
        raise ValueError('审阅支持须回指本次实际底层版本。')


def annotations(value, row):
    allowed = {'input_sha256', 'reviewer', 'dimension', 'scenario_key', 'decision', 'supported_claims',
               'prohibited_claims', 'independence_notes', 'empty_support_policy', 'verifier_challenges'}
    if not isinstance(value, dict) or set(value) != allowed:
        raise ValueError('支持标注合同无效。')
    if value['input_sha256'] != row['input_sha256']:
        raise LayeredMemoryConflict('支持标注属于另一份实际模型输入。')
    reviewer(value['reviewer'])
    decision(value['decision'])
    if (value['dimension'] not in SEMANTIC_DIMENSIONS or not isinstance(value['scenario_key'], str)
            or not 1 <= len(value['scenario_key']) <= 160 or not isinstance(value['independence_notes'], str)
            or not value['independence_notes'].strip() or len(value['independence_notes']) > 2000
            or value['empty_support_policy'] not in {'normal', 'reject', 'uncertain_summary_allowed'}):
        raise ValueError('须明确独立场景、语义维度与空支持合同。')
    for name in ('supported_claims', 'prohibited_claims'):
        claims = value[name]
        if not isinstance(claims, list) or len(claims) > 80:
            raise ValueError('支持及禁用主张须有限。')
        for claim in claims:
            required = ({'claim_id', 'text', 'references', 'allowed_layers', 'required_qualifiers'} if name == 'supported_claims'
                        else {'claim_id', 'text', 'reason'})
            if not isinstance(claim, dict) or set(claim) != required or any(not isinstance(claim[k], str)
                    or not claim[k].strip() or len(claim[k]) > 4000 for k in ('claim_id', 'text')):
                raise ValueError('标注主张结构无效。')
            if name == 'supported_claims':
                references(claim['references'], row)
                if (not isinstance(claim['allowed_layers'], list) or not claim['allowed_layers']
                        or set(claim['allowed_layers']) - {'l2', 'l3'} or not isinstance(claim['required_qualifiers'], list)
                        or any(not isinstance(item, str) or len(item) > 1000 for item in claim['required_qualifiers'])):
                    raise ValueError('须明确可用层级与必要限定。')
            elif not isinstance(claim['reason'], str) or not claim['reason'].strip():
                raise ValueError('禁用主张须说明原因。')
    challenges = value['verifier_challenges']
    if not isinstance(challenges, dict) or set(challenges) - {'l2', 'l3'}:
        raise ValueError('核验挑战只能是分别冻结的两层候选。')
    # 挑战只保存候选提案；标签、正确答案和评分从不发给核验模型。
    for layer, challenge in challenges.items():
        if not isinstance(challenge, dict) or set(challenge) != {'proposal', 'expected_supported'} or challenge['expected_supported'] is not False:
            raise ValueError('负例挑战须明确人工否决的完整候选提案。')
    return value


def output_review(value, row):
    allowed = {'output_sha256', 'reviewer', 'decision', 'claims', 'projection_passed', 'verifier_challenges_reviewed'}
    if not isinstance(value, dict) or set(value) != allowed or row['output_payload'] is None:
        raise ValueError('须对实际输出逐项审阅。')
    if value['output_sha256'] != content_digest(row['output_payload']):
        raise LayeredMemoryConflict('输出已变化，旧审阅不能沿用。')
    reviewer(value['reviewer'])
    decision(value['decision'])
    claims = value['claims']
    paths = {item['path'] for item in output_items(row['output_payload'])}
    if (not isinstance(claims, list) or len(claims) != len(paths) or {c.get('path') for c in claims if isinstance(c, dict)} != paths
            or type(value['projection_passed']) is not bool or type(value['verifier_challenges_reviewed']) is not bool):
        raise ValueError('每项实际生成目录、正文与背景均须有支持决定。')
    for claim in claims:
        if (not isinstance(claim, dict) or set(claim) != {'path', 'supported', 'references', 'critical_errors', 'notes'}
                or type(claim['supported']) is not bool or not isinstance(claim['notes'], str)
                or len(claim['notes']) > 2000 or not isinstance(claim['critical_errors'], list)
                or set(claim['critical_errors']) - (SEMANTIC_DIMENSIONS | {'scope', 'unsupported'})):
            raise ValueError('逐项支持决定结构无效。')
        references(claim['references'], row)
    return value
