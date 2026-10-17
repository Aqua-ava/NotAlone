"""校验模型建议，应用层分配方法身份与可审核映射，不执行发布。"""

import json
import re
from uuid import UUID, uuid5

from notalone.skills.learning import SkillLearningInvalid, content_digest
from notalone.skills.package import RawSkillPackage, SkillPackageValidator


def normalize_proposal(scope, batch, proposal):
    if not isinstance(proposal, dict):
        raise SkillLearningInvalid()
    outcome = proposal.get('outcome')
    if outcome == 'no_change':
        return None, outcome
    available = {item['skill_id']: item for item in batch.targets}
    target_ids = proposal.get('target_skill_ids', [])
    if (not isinstance(target_ids, list) or not all(isinstance(item, str) for item in target_ids)
            or len(set(target_ids)) != len(target_ids)
            or any(identifier not in available for identifier in target_ids)):
        raise SkillLearningInvalid()
    if outcome == 'reuse' and target_ids:
        return None, outcome
    kind = proposal.get('proposal_kind')
    if (outcome != 'draft' or kind not in ('create', 'update', 'merge')
            or kind == 'create' and target_ids or kind == 'update' and len(target_ids) != 1
            or kind == 'merge' and len(target_ids) < 2):
        raise SkillLearningInvalid()
    name = proposal.get('name')
    description, scene = proposal.get('description'), proposal.get('scene')
    if (not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', name)
            or len(name) > 64 or not isinstance(description, str) or not description.strip()
            or len(description) > 1024 or not isinstance(scene, str) or not scene.strip() or len(scene) > 256):
        raise SkillLearningInvalid()
    # 同名已存在时必须建议更新或复用，不能伪造另一个逻辑Skill。
    if kind == 'create' and any(item['name'] == name for item in batch.targets):
        raise SkillLearningInvalid()
    suggestion = proposal.get('scope_suggestion')
    if (not isinstance(suggestion, dict) or set(suggestion) != {'kind', 'reason'}
            or suggestion['kind'] not in ('contact', 'scene', 'owner')
            or not isinstance(suggestion['reason'], str) or not suggestion['reason'].strip()
            or len(suggestion['reason']) > 1024):
        raise SkillLearningInvalid()
    methods = proposal.get('methods')
    if not isinstance(methods, list) or not 1 <= len(methods) <= 6:
        raise SkillLearningInvalid()
    targets = [available[identifier] for identifier in target_ids]
    logical = UUID(target_ids[0]) if targets else uuid5(scope.contact_id, 'learned_skill:' + name)
    target_methods = {method['method_id'] for target in targets for method in target['methods']}
    normalized, seen = [], set()
    for method in methods:
        if not isinstance(method, dict) or set(method) - {'key', 'title', 'instruction', 'replaces_method_ids'}:
            raise SkillLearningInvalid()
        key, title, instruction = method.get('key'), method.get('title'), method.get('instruction')
        if (not isinstance(key, str) or not re.fullmatch('[a-z][a-z0-9-]{0,63}', key) or key in seen
                or not isinstance(title, str) or not title.strip() or len(title) > 256
                or not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 2048):
            raise SkillLearningInvalid()
        seen.add(key)
        replaces = method.get('replaces_method_ids', sorted(target_methods))
        if (not isinstance(replaces, list) or any(identifier not in target_methods for identifier in replaces)
                or len(set(replaces)) != len(replaces) or targets and not replaces):
            raise SkillLearningInvalid()
        normalized.append({'method_id': str(uuid5(logical, 'method:' + key)), 'logical_skill_id': str(logical),
                           'key': key, 'title': title, 'instruction': instruction,
                           'replaces_method_ids': replaces,
                           'mapping_status': 'requires_review' if targets else 'new'})
    if target_methods - {identifier for method in normalized for identifier in method['replaces_method_ids']}:
        raise SkillLearningInvalid()
    body = '# ' + scene + '\n\n' + '\n\n'.join('## ' + item['title'] + '\n' + item['instruction'] for item in normalized)
    document = '---\nname: ' + name + '\ndescription: ' + json.dumps(description, ensure_ascii=False) + '\n---\n' + body
    SkillPackageValidator().validate(RawSkillPackage(name, document.encode(), ()))
    strategy = {'name': name, 'description': description, 'scene': scene, 'document': document,
                'methods': normalized, 'scope_suggestion': {**suggestion,
                    'contact_id': str(scope.contact_id) if suggestion['kind'] == 'contact' else None}}
    # 不把长逐字原文当成清洗后教学策略；这一机械门不等于真人隐私/质量审核。
    strategy_text = json.dumps(strategy, ensure_ascii=False)
    for material in batch.materials:
        for value in _text_values({key: material.get(key) for key in ('content', 'candidates', 'external_messages')}):
            if len(value.strip()) >= 16 and value.strip() in strategy_text:
                raise SkillLearningInvalid()
    return {'logical_skill_id': logical, 'proposal_kind': kind, 'strategy': strategy,
            'target_versions': [{key: target[key] for key in ('skill_id', 'version_id', 'version_number')} for target in targets]}, 'draft'


def _text_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _text_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from _text_values(child)
