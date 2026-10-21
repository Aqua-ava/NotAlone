"""持久化账号级同步范围及按稳定微信身份自动纳入会话。"""
from dataclasses import dataclass
from hashlib import sha256
from time import monotonic
from datetime import datetime
from uuid import UUID
from collections.abc import Sequence

import psycopg
from notalone.persistence.locks import lock_owner_scope
from notalone.wechat_cli.models import ChatCandidate


@dataclass(frozen=True, slots=True)
class SyncScopeState:
    mode: str = 'selected'
    granted_at: datetime | None = None


class PostgresSyncScopeStore:
    def __init__(self, database_url: str):
        self._database_url = database_url

    def read(self, *, owner_id: UUID, channel: str, account_scope: str) -> SyncScopeState:
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '2000ms'")
            row = connection.execute(
                'SELECT mode,granted_at FROM public.wechat_sync_scope WHERE owner_id=%s AND channel=%s AND account_scope=%s',
                (owner_id,channel,account_scope),
            ).fetchone()
        return SyncScopeState(*row) if row else SyncScopeState()

    def set_mode(self, *, owner_id: UUID, channel: str, account_scope: str, mode: str, at: datetime) -> None:
        if mode not in ('selected', 'all_private'):
            raise ValueError('同步范围无效。')
        if at.tzinfo is None:
            raise ValueError('授权时间必须带时区。')
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '2000ms'")
            lock_owner_scope(connection, owner_id=owner_id)
            connection.execute('''
                INSERT INTO public.wechat_sync_scope(owner_id,channel,account_scope,mode,granted_at)
                VALUES(%s,%s,%s,%s,%s)
                ON CONFLICT(owner_id,channel,account_scope) DO UPDATE SET
                mode=EXCLUDED.mode, updated_at=now(),
                granted_at=CASE WHEN wechat_sync_scope.mode='all_private' AND EXCLUDED.mode='all_private'
                    THEN wechat_sync_scope.granted_at ELSE EXCLUDED.granted_at END
            ''', (owner_id,channel,account_scope,mode,at if mode=='all_private' else None))

    def enroll(self, *, owner_id: UUID, channel: str, account_scope: str, sessions: Sequence[ChatCandidate]) -> int:
        """在同一事务重查授权、排除与身份；同名不同账号永不合并。"""
        created = 0
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '3000ms'")
            lock_owner_scope(connection, owner_id=owner_id)
            row = connection.execute(
                'SELECT mode,granted_at FROM public.wechat_sync_scope WHERE owner_id=%s AND channel=%s AND account_scope=%s FOR UPDATE',
                (owner_id,channel,account_scope),
            ).fetchone()
            if not row or row[0] != 'all_private':
                return 0
            baseline_at = row[1]
            known = {item[0] for item in connection.execute(
                'SELECT conversation_locator FROM public.conversation_binding WHERE owner_id=%s AND channel=%s AND account_scope=%s',
                (owner_id,channel,account_scope),
            ).fetchall()}
            excluded = {bytes(item[0]) for item in connection.execute(
                'SELECT locator_hash FROM public.wechat_sync_exclusion WHERE owner_id=%s AND channel=%s AND account_scope=%s',
                (owner_id,channel,account_scope),
            ).fetchall()}
            identities_by_locator: dict[str, list[tuple[UUID, str]]] = {}
            for locator, contact_id, status in connection.execute(
                'SELECT external_id,contact_id,status FROM public.channel_identity WHERE owner_id=%s AND channel=%s AND external_id=ANY(%s)',
                (owner_id,channel,[session.username for session in sessions]),
            ).fetchall():
                identities_by_locator.setdefault(locator, []).append((contact_id,status))
            started = monotonic()
            for session in sessions:
                # 把持续授权分成有限写入批次，下一轮继续剩余会话。
                if created >= 250 or monotonic() - started >= 2:
                    break
                if session.chat_type != 'private':
                    continue
                locator = session.username
                if locator in known or sha256(locator.encode('utf-8')).digest() in excluded:
                    continue
                identities = identities_by_locator.get(locator, [])
                active = {identity[0] for identity in identities if identity[1]=='active'}
                if len(active)>1:
                    raise ValueError('sync_scope_identity_conflict')
                if identities and not active:
                    continue
                contact_id = next(iter(active)) if active else connection.execute(
                    'INSERT INTO public.contact(owner_id,display_name) VALUES(%s,%s) RETURNING id',
                    (owner_id,session.display_name or locator),
                ).fetchone()[0]
                binding = connection.execute('''INSERT INTO public.conversation_binding
                    (owner_id,contact_id,channel,account_scope,conversation_locator,display_name)
                    VALUES(%s,%s,%s,%s,%s,%s) RETURNING id''',
                    (owner_id,contact_id,channel,account_scope,locator,session.display_name or locator)).fetchone()[0]
                connection.execute('''INSERT INTO public.wechat_observation_baseline
                    (owner_id,contact_id,binding_id,conversation_locator,baseline_at) VALUES(%s,%s,%s,%s,%s)''',
                    (owner_id,contact_id,binding,locator,baseline_at))
                known.add(locator)
                created += 1
        return created
