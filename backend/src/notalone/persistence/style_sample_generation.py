"""主动样本的非正文生成依赖；不要求原助手会话继续存在。"""

from typing import Any
from uuid import UUID

from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


def capture_sample_generation_dependencies(connection: Any, scope: ContactScope, sample: dict) -> set[UUID]:
    """调用方持有 owner 锁；完整空集可保存，无法证明的旧链保持未知。"""
    captured = connection.execute(
        "SELECT dependency_ids FROM public.style_sample_generation_dependency "
        "WHERE owner_id=%s AND contact_id=%s AND sample_id=%s",
        (scope.owner_id, scope.contact_id, sample['id']),
    ).fetchone()
    if captured is not None:
        return set(captured['dependency_ids'])
    dependencies = set(sample['dependency_sample_ids'])
    if sample['origin_kind'] == 'candidate':
        origin = connection.execute(
            "SELECT request.id FROM public.reply_candidate AS candidate "
            "JOIN public.reply_request AS request ON request.id=candidate.reply_request_id "
            "AND request.owner_id=candidate.owner_id AND request.contact_id=candidate.contact_id "
            "WHERE candidate.owner_id=%s AND candidate.contact_id=%s AND candidate.id=%s "
            "AND request.state='completed' AND request.context_snapshot IS NOT NULL",
            (scope.owner_id, scope.contact_id, sample['origin_id']),
        ).fetchone()
        if origin is None:
            raise ReplyStoreInvariantError('表达样本的原生成依赖未知，只能回看，请重新生成。')
        from notalone.persistence.assistant_session_store import _reply_dependencies
        from notalone.persistence.style_sample_store import require_reply_sources_current

        require_reply_sources_current(connection, owner_id=scope.owner_id, request_id=origin['id'], historical=True)
        dependencies.update(_reply_dependencies(connection, scope, origin['id']))
    connection.execute(
        "INSERT INTO public.style_sample_generation_dependency(sample_id,owner_id,contact_id,dependency_ids) "
        "VALUES (%s,%s,%s,%s) ON CONFLICT (sample_id) DO NOTHING",
        (sample['id'], scope.owner_id, scope.contact_id, sorted(dependencies)),
    )
    return dependencies


def preserve_sample_generation_dependencies(connection: Any, scope: ContactScope, request_ids: list[UUID]) -> None:
    """会话删除前回填旧样本；未知链不阻止删除，也不得获得生成资格。"""
    rows = connection.execute(
        "SELECT sample.* FROM public.style_sample AS sample "
        "JOIN public.reply_candidate AS candidate ON candidate.id=sample.origin_id "
        "AND candidate.owner_id=sample.owner_id AND candidate.contact_id=sample.contact_id "
        "WHERE sample.owner_id=%s AND sample.contact_id=%s AND sample.status='active' "
        "AND sample.origin_kind='candidate' AND candidate.reply_request_id=ANY(%s::uuid[])",
        (scope.owner_id, scope.contact_id, request_ids),
    ).fetchall()
    for sample in rows:
        try:
            capture_sample_generation_dependencies(connection, scope, sample)
        except ReplyStoreInvariantError:
            # 只拒绝未知旧依赖；删除本身仍须完成，不从缺失链制造完整快照。
            continue
