"""底层写入前按实际参与依赖精确清理整理资料的回复副本。"""

from notalone.persistence.reply_cleanup import delete_source_replies


def erase_layered_reply_dependencies(connection, scope, identifiers):
    """先取不可变版本身份，再复用既有完整闭包；不扫描历史回复JSON。"""
    # 旧ANY库尚无分层资料，不能凭空产生该类回复依赖；部分缺表仍由下方查询拒绝写入。
    absent = connection.execute(
        "SELECT to_regclass('public.scenario_document_version') IS NULL "
        "AND to_regclass('public.layered_memory_batch') IS NULL "
        "AND to_regclass('public.layered_profile_version') IS NULL "
        "AND to_regclass('public.layered_profile_batch') IS NULL AS absent"
    ).fetchone()["absent"]
    if absent:
        return
    rows = connection.execute(
        "SELECT v.id FROM public.scenario_document_version v "
        "JOIN public.layered_memory_batch b ON b.id=v.batch_id "
        "WHERE b.owner_id=%s AND b.contact_id IS NOT DISTINCT FROM %s AND b.dependency_ids && %s::uuid[] "
        "UNION SELECT v.id FROM public.layered_profile_version v "
        "JOIN public.layered_profile_batch b ON b.id=v.batch_id "
        "WHERE b.owner_id=%s AND b.contact_id IS NOT DISTINCT FROM %s AND b.dependency_ids && %s::uuid[]",
        (scope.owner_id, scope.contact_id, list(identifiers)) * 2,
    ).fetchall()
    if rows:
        delete_source_replies(connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
            removed_ids={row["id"] for row in rows}, revoke_running_scope=False)
