"""每次生成重新读取联系人的全部有效绑定覆盖；旧增量授权保持原行为。"""

from uuid import UUID

import psycopg

from notalone.persistence.history_authorization import HISTORY_SYNC_AUTHORIZATION_VERSION
from notalone.persistence.history_sync_state import HistorySyncStatePersistenceError


class PostgresReplyHistoryCoverage:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def __call__(self, owner_id: UUID, contact_id: UUID) -> str | None:
        try:
            with psycopg.connect(self._database_url) as connection:
                rows = connection.execute(
                    """SELECT coalesce(history.phase, 'not_started')
                    FROM public.conversation_binding AS binding
                    LEFT JOIN public.cli_history_sync_state AS history
                      ON history.owner_id = binding.owner_id
                     AND history.contact_id = binding.contact_id
                     AND history.binding_id = binding.id
                    LEFT JOIN public.wechat_history_sync_authorization AS grant_state
                      ON grant_state.owner_id = binding.owner_id
                     AND grant_state.channel = binding.channel
                     AND grant_state.account_scope = binding.account_scope
                    WHERE binding.owner_id = %s AND binding.contact_id = %s
                      AND binding.status = 'active' AND binding.channel = 'wechat'
                      AND (history.binding_id IS NOT NULL OR
                           grant_state.decision = 'accepted' AND grant_state.version >= %s)
                    """, (owner_id, contact_id, HISTORY_SYNC_AUTHORIZATION_VERSION),
                ).fetchall()
        except psycopg.Error:
            raise HistorySyncStatePersistenceError("回复前历史覆盖读取失败。") from None
        phases = {row[0] for row in rows}
        # 任一绑定尚未追平时不能由另一绑定的不完整确认绕过。
        for phase in ("not_started", "syncing", "incomplete", "complete"):
            if phase in phases:
                return phase
        return None
