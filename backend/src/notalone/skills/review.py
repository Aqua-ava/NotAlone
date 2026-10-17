"""审核动作的冻结输入、显式范围与清洗策略校验。"""

from types import SimpleNamespace
from uuid import UUID

from notalone.skills.draft_proposal import normalize_proposal


def review_input(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {'incoming_text', 'intent', 'scene'}:
        raise ValueError('审核输入无效。')
    limits = {'incoming_text': 8192, 'intent': 4096, 'scene': 256}
    if any(not isinstance(value[key], str) or not value[key].strip()
           or len(value[key]) > limit for key, limit in limits.items()):
        raise ValueError('审核输入无效。')
    return {key: text.strip() for key, text in value.items()}


def publication_scope(value: object, contact_id: UUID, *, scene: str | None = None) -> dict:
    if not isinstance(value, dict) or set(value) != {'kind', 'contact_id', 'scene'}:
        raise ValueError('发布范围无效。')
    kind, contact, declared_scene = value['kind'], value['contact_id'], value['scene']
    if kind == 'contact' and contact == str(contact_id) and declared_scene is None:
        return dict(value)
    if kind == 'owner' and contact is None and declared_scene is None:
        return dict(value)
    if (kind == 'scene' and contact is None and isinstance(declared_scene, str)
            and declared_scene.strip() == declared_scene and 0 < len(declared_scene) <= 256
            and (scene is None or scene == declared_scene)):
        return dict(value)
    raise ValueError('发布范围无效。')


def edited_strategy(scope, draft: dict, value: object) -> dict:
    if (not isinstance(value, dict)
            or set(value) != {'name', 'description', 'scene', 'methods'}):
        raise ValueError('审核策略无效。')
    evidence = draft['private_evidence']
    batch = SimpleNamespace(materials=evidence['materials'], targets=evidence['existing_skills'])
    proposal = {**value, 'outcome': 'draft', 'proposal_kind': draft['proposal_kind'],
                'target_skill_ids': [item['skill_id'] for item in draft['target_versions']],
                'scope_suggestion': {key: draft['sanitized_strategy']['scope_suggestion'][key]
                                     for key in ('kind', 'reason')}}
    normalized, _ = normalize_proposal(scope, batch, proposal)
    if str(normalized['logical_skill_id']) != draft['logical_skill_id']:
        # 新建草稿改名不改变逻辑身份与旧方法的归属。
        from uuid import uuid5
        logical = UUID(draft['logical_skill_id'])
        for method in normalized['strategy']['methods']:
            method['logical_skill_id'] = str(logical)
            method['method_id'] = str(uuid5(logical, 'method:' + method['key']))
    return normalized['strategy']
