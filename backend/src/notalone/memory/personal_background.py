"""个人资料的命题类别；推断与事实不互相升级，也不承载行动指导。"""

KINDS = frozenset({'fact', 'preference', 'inference', 'contradiction'})
L2_SECTIONS = frozenset({'basic_information', 'core_traits', 'explicit_preferences', 'implicit_signals', 'narrative', 'evolution', 'contradictions'})
L3_SECTIONS = frozenset({'basic_information', 'long_term_preferences', 'life_context', 'interests', 'insights', 'evolution', 'contradictions'})
FIELDS = frozenset({'kind', 'section', 'basis'})


def validate_metadata(item, *, profile=False):
    """旧正文兼容；新表达必须完整声明类别、章节及依据。"""
    if not (set(item) & FIELDS):
        return {}
    if not FIELDS <= set(item) or item['kind'] not in KINDS:
        raise ValueError('个人资料须明确区分事实、偏好、推断与矛盾。')
    if item['section'] not in (L3_SECTIONS if profile else L2_SECTIONS):
        raise ValueError('个人资料章节无效；沟通策略与决策指导不属于背景。')
    if not isinstance(item['basis'], str) or not item['basis'].strip() or len(item['basis']) > 1000:
        raise ValueError('个人资料须保留具体依据。')
    uncertainty = item.get('uncertainty')
    if not isinstance(uncertainty, str) or len(uncertainty) > 240:
        raise ValueError('个人资料须保留不确定性字段。')
    if item['kind'] in {'inference', 'contradiction'} and not uncertainty.strip():
        raise ValueError('推断与未解矛盾不得省略不确定性。')
    if profile and item['kind'] in {'inference', 'contradiction'} and item['temporal_status'] != 'uncertain':
        raise ValueError('推断和矛盾不能自动升级为确定的稳定或历史事实。')
    return {key: item[key] for key in (*FIELDS, 'uncertainty')}
