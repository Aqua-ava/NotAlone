"""规范消息来源引用的共享 SQL 片段。

一条规范消息可由多个来源（历史导入或本地微信 CLI 观察）共同支持。
消息只有存在至少一个有效来源引用时才可检索：导入来源必须仍为
active，CLI 观察来源存在即有效（删除路径为硬删除）。
"""

from __future__ import annotations


def source_ref_content_sha_sql(ref_alias: str = "ref") -> str:
    """读取同范围历史来源的既有指纹，不读取文件或新增业务字段。"""

    return f"""
    SELECT source.content_sha256 FROM public.source_document AS source
    WHERE source.id={ref_alias}.source_document_id
      AND source.owner_id={ref_alias}.owner_id
      AND source.contact_id={ref_alias}.contact_id
      AND source.status='active'
    """


def active_source_ref_sql(ref_alias: str = "ref") -> str:
    """单一引用须仍有效；同消息另一有效引用不能恢复旧定位。"""

    return f"""
    (
        EXISTS (
            SELECT 1 FROM public.local_wechat_observation AS observation
            WHERE observation.id={ref_alias}.observation_id
              AND observation.owner_id={ref_alias}.owner_id
              AND observation.contact_id={ref_alias}.contact_id
        )
        OR EXISTS (
            SELECT 1 FROM public.source_document AS active_source
            WHERE active_source.id = {ref_alias}.source_document_id
              AND active_source.owner_id = {ref_alias}.owner_id
              AND active_source.contact_id = {ref_alias}.contact_id
              AND active_source.status = 'active'
        )
    )
    """


def valid_source_ref_exists_sql(message_alias: str) -> str:
    """返回 ``EXISTS`` 片段：该消息至少有一个有效来源引用。

    ``message_alias`` 是外层查询中 ``public.message`` 的别名。
    """

    return f"""
    EXISTS (
        SELECT 1
        FROM public.message_source_ref AS ref
        WHERE ref.message_id = {message_alias}.id
          AND ref.owner_id = {message_alias}.owner_id
          AND ref.contact_id = {message_alias}.contact_id
          AND (
              (
                  ref.source_document_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM public.source_document AS source
                      WHERE source.id = ref.source_document_id
                        AND source.owner_id = ref.owner_id
                        AND source.contact_id = ref.contact_id
                        AND source.status = 'active'
                  )
              )
              OR ref.observation_id IS NOT NULL
          )
    )
    """


def valid_source_ids_sql(message_alias: str) -> str:
    """返回标量子查询片段：该消息全部有效来源的 UUID 数组。

    数组元素按 ``UNION`` 去重；没有任何有效来源时返回空数组。
    """

    return f"""
    COALESCE(
        (
            SELECT array_agg(source_id)
            FROM (
                SELECT ref.source_document_id AS source_id
                FROM public.message_source_ref AS ref
                WHERE ref.message_id = {message_alias}.id
                  AND ref.source_document_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1
                      FROM public.source_document AS source
                      WHERE source.id = ref.source_document_id
                        AND source.owner_id = ref.owner_id
                        AND source.contact_id = ref.contact_id
                        AND source.status = 'active'
                  )
                UNION
                SELECT ref.observation_id AS source_id
                FROM public.message_source_ref AS ref
                WHERE ref.message_id = {message_alias}.id
                  AND ref.observation_id IS NOT NULL
            ) AS valid_refs
        ),
        '{{}}'::uuid[]
    )
    """
