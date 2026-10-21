"""从已授权会话选择任务相关的增量材料，按已发布身份读取策略文件。"""

from heapq import merge
from uuid import UUID, uuid5
from psycopg.rows import dict_row

from notalone.persistence.assistant_session_store import _expand_message_sources
from notalone.persistence.message_sources import valid_source_ref_exists_sql
from notalone.skills.learning import LearningBatch, MAX_LEARNING_MATERIALS, MAX_LEARNING_INPUT_CHARS, content_digest, learning_input_text
from notalone.persistence.skill_learning_generation import capture_generation
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.persistence.skill_files import SkillFileError, read_version_content


def expand_learning_provenance(connection, scope, dependencies) -> set[UUID] | None:
    """沿实际历史身份继承来源；停用目录不改变已经使用过的Skill来历。"""
    from notalone.persistence.reply_discussion_dependencies import (
        reply_discussion_request_dependencies,
    )

    refs, checked = set(dependencies), set()
    while True:
        rows = connection.execute("""
            WITH RECURSIVE material_provenance(id) AS (
                SELECT unnest(%(dependencies)s::uuid[])
                UNION
                SELECT edge.id FROM material_provenance AS origin
                CROSS JOIN LATERAL (
                    SELECT turn.reply_request_id AS id FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=%(owner_id)s AND turn.contact_id=%(contact_id)s
                      AND turn.id=origin.id AND turn.state='completed'
                    UNION ALL SELECT turn.id FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=%(owner_id)s AND turn.contact_id=%(contact_id)s
                      AND turn.reply_request_id=origin.id AND turn.state='completed'
                    UNION ALL SELECT unnest(turn.dependency_ids) FROM public.assistant_session_turn AS turn
                    WHERE turn.owner_id=%(owner_id)s AND turn.contact_id=%(contact_id)s
                      AND turn.id=origin.id AND turn.state='completed'
                    UNION ALL SELECT input.turn_id FROM public.assistant_session_input AS input
                    WHERE input.owner_id=%(owner_id)s AND input.contact_id=%(contact_id)s AND input.id=origin.id
                    UNION ALL SELECT unnest(input.dependency_ids) FROM public.assistant_session_input AS input
                    WHERE input.owner_id=%(owner_id)s AND input.contact_id=%(contact_id)s AND input.id=origin.id
                    UNION ALL SELECT version.turn_id FROM public.assistant_candidate_version AS version
                    WHERE version.owner_id=%(owner_id)s AND version.contact_id=%(contact_id)s AND version.id=origin.id
                    UNION ALL SELECT selection.candidate_id FROM public.assistant_candidate_selection AS selection
                    WHERE selection.owner_id=%(owner_id)s AND selection.contact_id=%(contact_id)s AND selection.id=origin.id
                    UNION ALL SELECT selection.version_id FROM public.assistant_candidate_selection AS selection
                    WHERE selection.owner_id=%(owner_id)s AND selection.contact_id=%(contact_id)s AND selection.id=origin.id
                    UNION ALL SELECT candidate.reply_request_id FROM public.reply_candidate AS candidate
                    WHERE candidate.owner_id=%(owner_id)s AND candidate.contact_id=%(contact_id)s AND candidate.id=origin.id
                    UNION ALL SELECT request.skill_id FROM public.reply_request AS request
                    WHERE request.owner_id=%(owner_id)s AND request.contact_id=%(contact_id)s AND request.id=origin.id
                    UNION ALL SELECT request.skill_version_id FROM public.reply_request AS request
                    WHERE request.owner_id=%(owner_id)s AND request.contact_id=%(contact_id)s AND request.id=origin.id
                    UNION ALL SELECT request.continued_from_candidate_id FROM public.reply_request AS request
                    WHERE request.owner_id=%(owner_id)s AND request.contact_id=%(contact_id)s AND request.id=origin.id
                    UNION ALL SELECT evidence.evidence_id FROM public.reply_context_evidence AS evidence
                    WHERE evidence.owner_id=%(owner_id)s AND evidence.contact_id=%(contact_id)s
                      AND evidence.reply_request_id=origin.id
                      AND evidence.kind NOT IN ('user_draft','user_purpose','continued_candidate')
                    UNION ALL SELECT use.source_id FROM public.reply_original_source_use AS use
                    WHERE use.owner_id=%(owner_id)s AND use.contact_id=%(contact_id)s AND use.reply_request_id=origin.id
                    UNION ALL SELECT use.preference_id FROM public.reply_expression_preference_use AS use
                    WHERE use.owner_id=%(owner_id)s AND use.contact_id=%(contact_id)s AND use.reply_request_id=origin.id
                    UNION ALL SELECT unnest(preference.source_ids) FROM public.expression_preference AS preference
                    WHERE preference.owner_id=%(owner_id)s
                      AND (preference.contact_id IS NULL OR preference.contact_id=%(contact_id)s)
                      AND preference.id=origin.id AND preference.status='active'
                    UNION ALL SELECT unnest(draft.dependency_ids) FROM public.skill_draft AS draft
                    WHERE draft.owner_id=%(owner_id)s AND draft.published_version_id=origin.id AND draft.status='published'
                ) AS edge WHERE edge.id IS NOT NULL
            ) SELECT id FROM material_provenance
        """, {'owner_id': scope.owner_id, 'contact_id': scope.contact_id, 'dependencies': list(refs)}).fetchall()
        refs.update(row[0] for row in rows)
        # C快照仍由唯一已有codec解码，不能从JSON自行推断助手讨论身份。
        requests = connection.execute(
            "SELECT id FROM public.reply_request WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[]) "
            "AND context_snapshot ? 'assistant_discussion_snapshot'",
            (scope.owner_id, scope.contact_id, list(refs - checked)),
        ).fetchall()
        if not requests:
            return refs
        try:
            for (request_id,) in requests:
                refs.update(reply_discussion_request_dependencies(connection, scope, request_id))
                checked.add(request_id)
        except ReplyStoreInvariantError:
            return None


def _published_methods(connection, scope, skill: UUID, version: UUID) -> list[dict[str, str]] | None:
    """身份注册不是发布证明；只沿本版本真实发布映射读取细分方法。"""
    row = connection.execute(
        "SELECT strategy->'methods' FROM public.skill_draft "
        "WHERE owner_id=%s AND logical_skill_id=%s AND published_version_id=%s AND status='published' "
        "ORDER BY created_at DESC,id DESC LIMIT 1",
        (scope.owner_id, skill, version),
    ).fetchone()
    if row is None:
        # 旧本地包缺少细分映射，整体策略身份不从尚未发布的草稿倒填。
        return [{'method_id': str(uuid5(skill, 'whole_strategy')), 'logical_skill_id': str(skill)}]
    raw = row[0]
    if not isinstance(raw, list) or not 1 <= len(raw) <= 6:
        return None
    methods = []
    seen = set()
    for item in raw:
        try:
            identifier, logical = UUID(item['method_id']), UUID(item['logical_skill_id'])
        except (KeyError, TypeError, ValueError, AttributeError):
            return None
        if logical != skill or identifier in seen:
            return None
        seen.add(identifier)
        methods.append({'method_id': str(identifier), 'logical_skill_id': str(logical)})
    return methods


def _paged_rows(connection, query, params):
    """每页最多32行；超预算材料不会永远占据固定扫描前缀。"""
    offset = 0
    while True:
        rows = connection.execute(query + ' LIMIT 32 OFFSET %s', (*params, offset)).fetchall()
        yield from rows
        if len(rows) < 32:
            return
        offset += 32


def _input_events(connection, scope, material_ids):
    params = (scope.owner_id, scope.contact_id)
    # 输入、纠正/编辑、明确选择各有稳定身份，生成原文只沿既有候选读取。
    rows = _paged_rows(connection, """
        SELECT input.id,input.session_id,input.content,turn.input_payload,
               coalesce(turn.dependency_ids,input.dependency_ids),turn.reply_request_id,
               input.created_at,input.turn_id
        FROM public.assistant_session_input AS input
        LEFT JOIN public.assistant_session_turn AS turn ON turn.id=input.turn_id
        JOIN public.conversation_binding AS binding ON binding.id=input.conversation_binding_id
        WHERE input.owner_id=%s AND input.contact_id=%s AND input.state='active'
          AND binding.owner_id=input.owner_id AND binding.contact_id=input.contact_id AND binding.status='active'
          AND (input.turn_id IS NULL OR turn.state='completed')
          AND (%s::uuid[] IS NULL OR input.id=ANY(%s::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM public.skill_learning_receipt AS receipt
              WHERE receipt.owner_id=input.owner_id AND receipt.contact_id=input.contact_id AND receipt.material_id=input.id)
        ORDER BY (coalesce(coalesce(input.content,turn.input_payload)->>'correction','')<>'') DESC,input.created_at,input.id
    """, (*params, list(material_ids) if material_ids is not None else None,
          list(material_ids) if material_ids is not None else None))
    for identifier, session_id, discussion, generated, dependencies, request_id, created_at, turn_id in rows:
        content = discussion or generated
        if not content:
            continue
        refs = set(dependencies) | {session_id, identifier}
        if turn_id:
            refs.add(turn_id)
        candidates = []
        if request_id:
            candidates = [{"candidate_id": str(row[0]), "message_group": row[1]}
                          for row in connection.execute(
                              "SELECT id,message_group FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s AND reply_request_id=%s ORDER BY id",
                              (*params, request_id)).fetchall()]
            refs.add(request_id)
            refs.update(UUID(item['candidate_id']) for item in candidates)
        yield {"material_id": str(identifier), "session_id": str(session_id),
                       "kind": 'assistant_discussion' if discussion else 'assistant_usage',
                       "priority": 'correction' if content.get('correction') else 'ordinary',
                       "content": content, "candidates": candidates, "dependencies": refs,
                       "created_at": str(created_at)}


def _edit_events(connection, scope, material_ids):
    params = (scope.owner_id, scope.contact_id)
    versions = _paged_rows(connection, """
        SELECT version.id,version.session_id,version.turn_id,version.candidate_id,
               version.message_group,version.requirements,version.created_at,turn.dependency_ids
        FROM public.assistant_candidate_version AS version
        JOIN public.assistant_session_turn AS turn ON turn.id=version.turn_id
        JOIN public.conversation_binding AS binding ON binding.id=turn.conversation_binding_id
        WHERE version.owner_id=%s AND version.contact_id=%s AND version.version_number>0
          AND turn.state='completed' AND binding.status='active'
          AND (%s::uuid[] IS NULL OR version.id=ANY(%s::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM public.skill_learning_receipt AS receipt
              WHERE receipt.owner_id=version.owner_id AND receipt.contact_id=version.contact_id AND receipt.material_id=version.id)
        ORDER BY version.created_at,version.id
    """, (*params, list(material_ids) if material_ids is not None else None,
          list(material_ids) if material_ids is not None else None))
    for identifier, session, turn, candidate, group, requirements, created, dependencies in versions:
        yield {"material_id": str(identifier), "session_id": str(session), "kind": 'candidate_edit',
                       "priority": 'correction', "content": {"message_group": group, "requirements": requirements},
                       "dependencies": set(dependencies) | {identifier, session, turn, candidate}, "created_at": str(created)}


def _selection_events(connection, scope, material_ids):
    params = (scope.owner_id, scope.contact_id)
    selections = _paged_rows(connection, """
        SELECT selection.id,selection.session_id,selection.candidate_id,selection.version_id,
               coalesce(version.message_group,candidate.message_group),selection.created_at,turn.dependency_ids,turn.id
        FROM public.assistant_candidate_selection AS selection
        JOIN public.assistant_candidate_version AS version ON version.id=selection.version_id
        JOIN public.reply_candidate AS candidate ON candidate.id=selection.candidate_id
        JOIN public.assistant_session_turn AS turn ON turn.id=version.turn_id
        JOIN public.conversation_binding AS binding ON binding.id=turn.conversation_binding_id
        WHERE selection.owner_id=%s AND selection.contact_id=%s AND turn.state='completed' AND binding.status='active'
          AND (%s::uuid[] IS NULL OR selection.id=ANY(%s::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM public.skill_learning_receipt AS receipt
              WHERE receipt.owner_id=selection.owner_id AND receipt.contact_id=selection.contact_id AND receipt.material_id=selection.id)
        ORDER BY selection.created_at,selection.id
    """, (*params, list(material_ids) if material_ids is not None else None,
          list(material_ids) if material_ids is not None else None))
    for identifier, session, candidate, version, group, created, dependencies, turn in selections:
        yield {"material_id": str(identifier), "session_id": str(session), "kind": 'candidate_selection',
                       "priority": 'ordinary', "content": {"message_group": group, "sending_status": 'unknown'},
                       "dependencies": set(dependencies) | {identifier, session, candidate, version, turn}, "created_at": str(created)}


def _followup_events(connection, scope, material_ids):
    params = (scope.owner_id, scope.contact_id)
    # 只沿实际生成任务的外部消息锚点，取同一已确认绑定24小时内的有限后续观察。
    # 时间相邻不证明发送或因果；没有外部锚点的改写任务不能据此读取聊天。
    followups = _paged_rows(connection, """
        SELECT message.id,message.text_content,message.speaker,message.occurred_at,
               task.id,task.session_id,task.dependency_ids,task.input_payload
        FROM public.message AS message
        JOIN LATERAL (
            SELECT turn.id,turn.session_id,turn.dependency_ids,turn.input_payload
            FROM public.assistant_session_turn AS turn
            JOIN public.conversation_binding AS binding ON binding.id=turn.conversation_binding_id
              AND binding.owner_id=turn.owner_id AND binding.contact_id=turn.contact_id
            WHERE turn.owner_id=message.owner_id AND turn.contact_id=message.contact_id
              AND turn.state='completed' AND binding.status='active'
              AND message.occurred_at>=turn.created_at
              AND message.occurred_at<=turn.created_at+interval '24 hours'
              AND EXISTS (
                  SELECT 1 FROM public.message AS anchor
                  WHERE anchor.owner_id=turn.owner_id AND anchor.contact_id=turn.contact_id
                    AND anchor.id=ANY(turn.dependency_ids) AND anchor.id<>message.id
                    AND anchor.occurred_at<=turn.created_at
              ) AND EXISTS (
                  SELECT 1 FROM public.message_source_ref AS ref
                  JOIN public.local_wechat_observation AS observation ON observation.id=ref.observation_id
                    AND observation.owner_id=ref.owner_id AND observation.contact_id=ref.contact_id
                  WHERE ref.message_id=message.id AND ref.owner_id=message.owner_id
                    AND ref.contact_id=message.contact_id AND observation.binding_id=binding.id
                    AND observation.is_reliable
              )
            ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1
        ) AS task ON true
        WHERE message.owner_id=%s AND message.contact_id=%s
          AND message.message_type='text' AND message.speaker IN ('user','contact')
          AND (%s::uuid[] IS NULL OR message.id=ANY(%s::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM public.skill_learning_receipt AS receipt
              WHERE receipt.owner_id=message.owner_id AND receipt.contact_id=message.contact_id
                AND receipt.material_id=message.id)
        ORDER BY message.occurred_at,message.id
    """, (*params, list(material_ids) if material_ids is not None else None,
          list(material_ids) if material_ids is not None else None))
    for identifier, text, speaker, occurred, turn, session, dependencies, task_input in followups:
        yield {'material_id': str(identifier), 'session_id': str(session),
                       'kind': 'followup_observation', 'priority': 'ordinary',
                       'content': {'text': text, 'speaker': speaker, 'task_input': task_input,
                                   'sending_status': 'unknown', 'effectiveness': 'unknown',
                                   'notice': '同绑定任务后24小时内的有限观察，不证明因果或实际采用。'},
                       'dependencies': set(dependencies) | {identifier, turn, session}, 'created_at': str(occurred)}


def select_learning_batch(connection, scope, *, material_ids=None) -> LearningBatch:
    params = (scope.owner_id, scope.contact_id)
    # 四个有序来源逐页归并；只保留本批完整材料，避免一次加载全部历史。
    events = merge(*(
        source(connection, scope, material_ids)
        for source in (_input_events, _edit_events, _selection_events, _followup_events)
    ), key=lambda item: (item['priority'] != 'correction', item['created_at'], item['material_id']))
    materials, all_dependencies = [], set()
    material_budget_limited = False
    for event in events:
        if material_ids is not None and UUID(event['material_id']) not in material_ids:
            continue
        refs = expand_learning_provenance(connection, scope, event.pop('dependencies'))
        if refs is None:
            continue
        from notalone.persistence.skill_version_lineage import capture_parent_publications
        from notalone.skills.learning import SkillLearningInvalid
        try:
            parents, inherited = capture_parent_publications(connection, scope, refs)
        except SkillLearningInvalid:
            continue
        # 已审核版本在原取材范围核验完整来历；当前材料只读本联系人的普通依赖。
        ordinary = refs - inherited
        with connection.cursor(row_factory=dict_row) as cursor:
            ordinary = _expand_message_sources(cursor, scope.owner_id, ordinary)
        refs = ordinary | inherited
        raw = connection.execute("""
            SELECT id FROM public.source_document WHERE id=ANY(%s::uuid[]) AND (owner_id<>%s OR contact_id<>%s)
            UNION ALL SELECT id FROM public.message WHERE id=ANY(%s::uuid[]) AND (owner_id<>%s OR contact_id<>%s)
            UNION ALL SELECT id FROM public.local_wechat_observation WHERE id=ANY(%s::uuid[]) AND (owner_id<>%s OR contact_id<>%s)
        """, (list(ordinary), *params, list(ordinary), *params, list(ordinary), *params)).fetchone()
        # 会话、真实历史Skill和原始资料共用恢复时的来源契约。
        original_refs = set(refs)
        if raw:
            continue
        from notalone.persistence.skill_learning import _dependencies_available_for_learning
        if not _dependencies_available_for_learning(connection, scope, refs):
            continue
        messages = connection.execute(f"""
            SELECT message.id,message.speaker,message.text_content,message.occurred_at
            FROM public.message AS message WHERE owner_id=%s AND contact_id=%s AND id=ANY(%s::uuid[])
              AND {valid_source_ref_exists_sql('message')} ORDER BY message.occurred_at NULLS LAST,message.id LIMIT 6
        """, (*params, list(ordinary))).fetchall()
        event['external_messages'] = [{"message_id": str(row[0]), "speaker": row[1], "text": row[2],
                                       "occurred_at": str(row[3]) if row[3] else None} for row in messages]
        # 模型只见所用版本身份；私密来历留在存储层的删除依赖中。
        event['dependency_ids'] = [str(identifier) for identifier in sorted(
            ordinary | {UUID(parent[key]) for parent in parents for key in ('skill_id', 'version_id')})]
        event['digest'] = content_digest(event)
        if connection.execute("SELECT 1 FROM public.skill_learning_receipt WHERE owner_id=%s AND contact_id=%s AND material_id=%s AND digest=%s",
                              (*params, UUID(event['material_id']), event['digest'])).fetchone():
            continue
        if len(learning_input_text((event,),())) > MAX_LEARNING_INPUT_CHARS:
            continue  # 超长单份材料不截断成貌似完整的经验。
        if len(materials) >= MAX_LEARNING_MATERIALS:
            break
        if len(learning_input_text((*materials,event),())) > MAX_LEARNING_INPUT_CHARS:
            # 后一份本身合法但无法合批，先推进已选完整材料，避免每次停在相同前缀。
            material_budget_limited = True
            break
        materials.append(event)
        all_dependencies.update(original_refs)
        if len(materials) >= MAX_LEARNING_MATERIALS:
            break
    targets = []
    revision = connection.execute('SELECT revision FROM public.skill_library WHERE owner_id=%s', (scope.owner_id,)).fetchone()
    for skill, version, name, description, number in connection.execute("""
        SELECT skill.id,version.id,skill.name,skill.description,version.version_number
        FROM public.reply_skill AS skill JOIN public.reply_skill_version AS version ON version.skill_id=skill.id
        WHERE skill.owner_id=%s AND skill.status='active' AND version.enabled AND version.is_current
          AND version.status='active' AND version.content_path IS NOT NULL AND version.directory_available
          AND version.name=skill.name
          AND (skill.contact_id IS NULL OR skill.contact_id=%s)
        ORDER BY skill.name,skill.id LIMIT 8
    """, params).fetchall():
        from notalone.persistence.skill_version_lineage import capture_parent_publications
        from notalone.skills.learning import SkillLearningInvalid
        try:
            proofs, provenance = capture_parent_publications(connection, scope, {version})
            if len(proofs) != 1:
                continue
        except SkillLearningInvalid:
            continue
        methods = _published_methods(connection, scope, skill, version)
        if methods is None:
            continue
        try:
            body = read_version_content(connection, version)
        except SkillFileError:
            continue
        target={"skill_id": str(skill), "version_id": str(version), "version_number": number,
                "name": name, "description": description, "document": body, "methods": methods,
                "scope": proofs[0]['scope'], "source_dependency_count": len(provenance)}
        if len(learning_input_text(materials,(*targets,target))) > MAX_LEARNING_INPUT_CHARS:
            continue
        inherited = expand_learning_provenance(connection, scope, {skill, version})
        from notalone.persistence.skill_learning import _dependencies_available_for_learning
        if inherited is None or not _dependencies_available_for_learning(connection, scope, inherited):
            continue
        targets.append(target)
        all_dependencies.update(inherited)
    setting = connection.execute('SELECT revision FROM public.skill_learning_scope WHERE owner_id=%s AND contact_id=%s', params).fetchone()
    return LearningBatch(tuple(materials), tuple(targets), tuple(sorted(all_dependencies)), revision[0] if revision else 0,
                         setting[0] if setting else 0, capture_generation(connection, scope, all_dependencies),
                         material_budget_limited)
