"""同一范围政策投影用于目录、正文、资源与提交；原发布内容保持不可变。"""

import json
from uuid import uuid5

from psycopg.rows import dict_row

from notalone.skills.learning import content_digest
from notalone.skills.models import SkillExecutionView


def _ancestry(cursor, owner_id, roots):
    edges, logical, pending = {}, {}, set(roots)
    while pending:
        if len(edges) + len(pending) > 256:
            raise PermissionError('方法延续范围无法可靠核验。')
        identifiers = pending
        pending = set()
        for value in identifiers:
            edges[value] = set()
        rows = cursor.execute('SELECT method.method_id,method.logical_skill_id,method.replaces_method_ids '
            'FROM public.reply_skill_method AS method JOIN public.reply_skill AS skill ON skill.id=method.logical_skill_id '
            'WHERE skill.owner_id=%s AND method.method_id=ANY(%s::uuid[])', (owner_id, list(identifiers))).fetchall()
        for row in rows:
            logical.setdefault(row['method_id'], set()).add(row['logical_skill_id'])
            edges[row['method_id']].update(row['replaces_method_ids'])
            pending.update(set(row['replaces_method_ids']) - set(edges))
    result = {}
    for root in roots:
        seen, queue = set(), [root]
        while queue:
            value = queue.pop()
            if value not in seen:
                seen.add(value)
                queue.extend(edges[value] - seen)
        result[root] = (seen, {skill for method in seen for skill in logical.get(method, ())})
    return result


def _blocked_policies(policies, skill_id, ancestors, logical_skills):
    return [item for item in policies if (
        item['method_id'] is not None and item['method_id'] in ancestors
        or item['method_id'] is None and (item['skill_id'] == skill_id or item['skill_id'] in logical_skills
            or uuid5(item['skill_id'], 'whole_strategy') in ancestors))]


def _policy_selection(connection, scope, row, scene, *, proposed_methods=None):
    """许可只依赖身份、映射与祖先；未选择版本不读取方法正文。"""
    connection = getattr(connection, 'connection', connection)
    with connection.cursor(row_factory=dict_row) as cursor:
        policies = cursor.execute('SELECT * FROM public.skill_scope_policy WHERE owner_id=%s '
            'AND (contact_id IS NULL OR contact_id=%s) AND (scene IS NULL OR scene=%s) ORDER BY id',
            (scope.owner_id, scope.contact_id, scene)).fetchall()
        methods = proposed_methods if proposed_methods is not None else cursor.execute(
            'SELECT method_id,replaces_method_ids,mapping_state,'
            'title IS NOT NULL AS has_title,instruction IS NOT NULL AS has_instruction '
            'FROM public.reply_skill_method WHERE version_id=%s ORDER BY ordinal', (row['version_id'],)).fetchall()
        if not row['review_origin'] and policies:
            historical = {item['method_id'] for item in cursor.execute(
                'SELECT method.method_id FROM public.reply_skill_method AS method '
                'JOIN public.reply_skill AS skill ON skill.id=method.logical_skill_id '
                'WHERE skill.owner_id=%s AND skill.id=%s', (scope.owner_id, row['skill_id'])).fetchall()}
            affinity = _ancestry(cursor, scope.owner_id, historical)
            if (any(item['skill_id'] == row['skill_id'] for item in policies)
                    or any(_blocked_policies(policies, row['skill_id'], ancestors, logical)
                           for ancestors, logical in affinity.values())):
                raise PermissionError('旧式包无法可靠排除该逻辑Skill或合并祖先已停用的方法。')
        if row['review_origin'] and (not methods or any(
                (item.get('title') is None or item.get('instruction') is None) if proposed_methods is not None else
                (not item['has_title'] or not item['has_instruction'])
                for item in methods) or any(
                item['mapping_state'] not in (('new', 'confirmed', 'requires_review')
                    if proposed_methods is not None else ('new', 'confirmed')) for item in methods)):
            if policies:
                raise PermissionError('无法可靠分离被停用的方法。')
        roots = [item['method_id'] for item in methods] or [uuid5(row['skill_id'], 'whole_strategy')]
        replacements = {value for item in methods for value in item['replaces_method_ids']} if proposed_methods is not None else set()
        ancestry = _ancestry(cursor, scope.owner_id, set(roots) | replacements) if policies else {
            value: ({value}, {row['skill_id']}) for value in roots}
        if policies and proposed_methods is not None:
            # 草稿尚未落入发布方法表；显式延续边也必须继承原方法的停用。
            for item in methods:
                ancestors, logical = ancestry[item['method_id']]
                for parent in item['replaces_method_ids']:
                    ancestors.update(ancestry[parent][0])
                    logical.update(ancestry[parent][1])
    allowed, relevant = [], {}
    for method in roots:
        ancestors, logical_skills = ancestry[method]
        blocked = _blocked_policies(policies, row['skill_id'], ancestors, logical_skills)
        relevant.update((item['id'], item) for item in blocked)
        if not blocked:
            allowed.append(method)
    if not allowed:
        raise PermissionError('Skill 已按明确范围停用。')
    filtered = len(allowed) != len(roots)
    if filtered:
        if not row['review_origin'] or not methods:
            raise PermissionError('无法可靠分离被停用的方法。')
    return tuple(allowed), relevant, filtered


def _project_metadata(row, filtered):
    projected = {**row, '_policy_filtered': filtered}
    if filtered:
        description = '已按用户范围决定筛选的教学方法，只使用本次可读正文。'
        projected['version_description'] = projected['skill_description'] = description
    return projected


def project_skill_metadata(connection, scope, row, scene):
    """目录与资源许可不构造正文、执行哈希或虚假的零修订凭证。"""
    _, _, filtered = _policy_selection(connection, scope, row, scene)
    return _project_metadata(row, filtered)


def project_skill_version(connection, scope, row, scene, *, proposed_methods=None):
    """仅为实际选择的版本构造允许正文及其真实执行凭证。"""
    allowed, relevant, filtered = _policy_selection(
        connection, scope, row, scene, proposed_methods=proposed_methods)
    projected = _project_metadata(row, filtered)
    if filtered:
        if proposed_methods is None:
            raw = getattr(connection, 'connection', connection)
            with raw.cursor(row_factory=dict_row) as cursor:
                methods = cursor.execute('SELECT method_id,title,instruction FROM public.reply_skill_method '
                    'WHERE version_id=%s AND method_id=ANY(%s::uuid[]) ORDER BY ordinal',
                    (row['version_id'], list(allowed))).fetchall()
        else:
            methods = [item for item in proposed_methods if item['method_id'] in allowed]
        if ({item['method_id'] for item in methods} != set(allowed)
                or any(item['title'] is None or item['instruction'] is None for item in methods)):
            raise PermissionError('允许的方法正文不完整。')
        description = projected['version_description']
        projected['version_content'] = ('---\nname: ' + row['version_name'] + '\ndescription: '
            + json.dumps(description, ensure_ascii=False) + '\n---\n# 本次允许的方法\n\n' + '\n\n'.join(
                '## ' + item['title'] + '\n' + item['instruction'] for item in methods if item['method_id'] in allowed))
    revision = max((item['revision'] for item in relevant.values()), default=0)
    projected['_execution_view'] = SkillExecutionView(revision, allowed, content_digest({
        'version_id': row['version_id'], 'document': projected['version_content'], 'methods': allowed,
        'policies': [(identifier, relevant[identifier]['revision']) for identifier in sorted(relevant)]}))
    return projected


def _own_skill_policy_change(connection, scope, request_id):
    """只投影已有候选的政策变化；不删除或重写候选与用户编辑。"""
    connection = getattr(connection, 'connection', connection)
    with connection.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute('SELECT request.skill_version_id,request.context_snapshot,request.normalized_input,'
            'request.idempotency_key,request.conversation_binding_id,'
            'skill.id AS skill_id,skill.status AS skill_status,version.id AS version_id,version.review_origin,version.content AS version_content,'
            'skill.name AS skill_name,version.name AS version_name,skill.description AS skill_description,'
            'version.description AS version_description FROM public.reply_request AS request '
            'LEFT JOIN public.reply_skill AS skill ON skill.id=request.skill_id AND skill.owner_id=request.owner_id '
            'LEFT JOIN public.reply_skill_version AS version ON version.id=request.skill_version_id AND version.skill_id=skill.id '
            'WHERE request.owner_id=%s AND request.contact_id=%s AND request.id=%s AND request.skill_version_id IS NOT NULL',
            (scope.owner_id, scope.contact_id, request_id)).fetchone()
    if row is None:
        return None
    version = row['skill_version_id']
    if row['skill_id'] is None or row['version_content'] is None or row['skill_status'] != 'active':
        return version
    try:
        snapshot = row['context_snapshot']
        if not isinstance(snapshot, dict) or not isinstance(row['normalized_input'], str):
            return version
        if row['normalized_input'].startswith('suggestion-sha256:'):
            # 旧B确认请求只保留摘要；场景沿同范围A权威输入读取，不能从发布范围猜测。
            with connection.cursor(row_factory=dict_row) as cursor:
                turn = cursor.execute('SELECT input_payload FROM public.assistant_session_turn WHERE owner_id=%s '
                    'AND contact_id=%s AND idempotency_key=%s AND conversation_binding_id=%s',
                    (scope.owner_id, scope.contact_id, row['idempotency_key'], row['conversation_binding_id'])).fetchone()
            if turn is None or not isinstance(turn['input_payload'], dict):
                return version
            scene = turn['input_payload'].get('scene')
        else:
            command = json.loads(row['normalized_input'])
            if not isinstance(command, dict) or command.get('mode') not in (
                    'reply_to_message', 'initiate_conversation', 'rewrite_draft'):
                return version
            scene = command.get('scene')
        if scene is not None and (not isinstance(scene, str) or not scene.strip() or scene != scene.strip() or len(scene) > 256):
            return version
        if 'skill_execution_scene' in snapshot and snapshot['skill_execution_scene'] != scene:
            return version
        current = project_skill_version(connection, scope, row, scene)['_execution_view']
        if 'skill_execution_view' not in snapshot:
            if current.policy_revision == 0:
                return None
        elif SkillExecutionView.from_payload(snapshot['skill_execution_view']) == current:
            return None
    except (PermissionError, ValueError, TypeError, AttributeError):
        pass
    return version


def saved_skill_policy_change(connection, scope, request_id):
    """沿实际捕获的候选身份复验，通用回复也不能洗掉旧方法的政策边。"""
    from notalone.application.assistant_candidate_carry import carry_origin_from_payload
    from notalone.reply.assistant_discussion import discussion_snapshot_from_payload

    raw = getattr(connection, 'connection', connection)
    pending, seen = {request_id}, set()
    with raw.cursor(row_factory=dict_row) as cursor:
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            if len(seen) > 256:
                return request_id
            changed = _own_skill_policy_change(raw, scope, current)
            if changed is not None:
                return changed
            row = cursor.execute('SELECT context_snapshot,continued_from_candidate_id FROM public.reply_request '
                'WHERE id=%s AND owner_id=%s AND contact_id=%s',
                (current, scope.owner_id, scope.contact_id)).fetchone()
            if row is None:
                continue
            candidates = {row['continued_from_candidate_id']} - {None}
            # 尚未保存上下文的用户输入没有新增 Skill 依据；已选 Skill 仍由上方复验。
            payload = row['context_snapshot'] if row['context_snapshot'] is not None else {}
            if not isinstance(payload, dict):
                return request_id
            if 'assistant_discussion_snapshot' in payload:
                try:
                    snapshot = discussion_snapshot_from_payload(payload['assistant_discussion_snapshot'])
                    if snapshot.scope != scope:
                        return request_id
                    candidates.update(item.candidate_id for item in snapshot.records
                                      if item.kind == 'candidate_version' and item.candidate_id is not None)
                    inputs = [item.input_version_id for item in snapshot.records if item.kind == 'discussion_input']
                    for item in cursor.execute('SELECT content FROM public.assistant_session_input WHERE owner_id=%s '
                            "AND contact_id=%s AND id=ANY(%s::uuid[]) AND input_type='candidate_carry'",
                            (scope.owner_id, scope.contact_id, inputs)).fetchall():
                        origin = carry_origin_from_payload(item['content'])
                        if (origin.origin_owner_id, origin.origin_contact_id) != (scope.owner_id, scope.contact_id):
                            return request_id
                        pending.add(origin.origin_reply_request_id)
                except (ValueError, TypeError, KeyError, AttributeError):
                    return request_id
            if candidates:
                parents = cursor.execute('SELECT reply_request_id FROM public.reply_candidate WHERE owner_id=%s '
                    'AND contact_id=%s AND id=ANY(%s::uuid[])',
                    (scope.owner_id, scope.contact_id, list(candidates))).fetchall()
                pending.update(item['reply_request_id'] for item in parents)
    return None


def require_saved_skill_policy(connection, scope, request_id):
    from notalone.reply.errors import ReplyInputInvalidatedError
    if saved_skill_policy_change(connection, scope, request_id) is not None:
        raise ReplyInputInvalidatedError('原候选的方法范围已改变，请保留编辑并重新生成。')
