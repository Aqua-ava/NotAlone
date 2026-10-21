"""首次连接的原子身份登记与授权；不修复或覆盖既有身份。"""
from datetime import datetime
from uuid import UUID
import psycopg
from notalone.application.wechat_setup import WechatSetupConflict
from notalone.persistence.locks import lock_owner_scope


class PostgresWechatSetupStore:
    def __init__(self, database_url: str) -> None:
        self._database_url = database_url

    def read(self, owner_id: UUID) -> str | None:
        with psycopg.connect(self._database_url, connect_timeout=2) as connection:
            connection.execute("SET LOCAL statement_timeout = '2000ms'")
            rows = connection.execute(
                "SELECT external_id,status FROM public.owner_channel_identity WHERE owner_id=%s AND channel='wechat'",
                (owner_id,),
            ).fetchall()
        if not rows:
            return None
        if len(rows) != 1 or rows[0][1] != 'active':
            raise WechatSetupConflict()
        return rows[0][0]

    def connect(self, owner_id: UUID, account_id: str, at: datetime) -> None:
        if not account_id or len(account_id) > 255 or at.tzinfo is None:
            raise ValueError('首次连接参数无效。')
        try:
            with psycopg.connect(self._database_url, connect_timeout=2) as connection:
                connection.execute("SET LOCAL statement_timeout = '3000ms'")
                lock_owner_scope(connection, owner_id=owner_id)
                # 同一外部账号跨 owner 首次连接也串行化；唯一索引继续兜底。
                connection.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))',
                                   ('wechat-setup-account:' + account_id,))
                rows = connection.execute(
                    "SELECT owner_id,external_id,status FROM public.owner_channel_identity WHERE channel='wechat' AND (owner_id=%s OR external_id=%s) FOR UPDATE",
                    (owner_id, account_id),
                ).fetchall()
                if rows:
                    if rows == [(owner_id, account_id, 'active')]:
                        # 已成功提交或曾手动配置的账号：重复确认不能再开开关、扩大范围。
                        return
                    raise WechatSetupConflict()
                connection.execute('''INSERT INTO public.owner_channel_identity
                    (owner_id,channel,external_id,observed_name,verified_at)
                    VALUES(%s,'wechat',%s,%s,%s)''', (owner_id, account_id, account_id, at))
                connection.execute('''INSERT INTO public.wechat_sync_scope
                    (owner_id,channel,account_scope,mode,granted_at)
                    VALUES(%s,'wechat',%s,'all_private',%s)''', (owner_id, account_id, at))
                connection.execute('''INSERT INTO public.front_sync_state
                    (owner_id,enabled,enabled_at) VALUES(%s,true,%s)
                    ON CONFLICT(owner_id) DO UPDATE SET enabled=true,enabled_at=EXCLUDED.enabled_at,updated_at=now()''',
                    (owner_id, at))
        except psycopg.errors.UniqueViolation:
            raise WechatSetupConflict() from None
