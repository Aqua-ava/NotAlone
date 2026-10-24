"""前台同步引擎的应用层装配：CLI 与常驻后端共用的薄壳构造逻辑。

两个入口都只做环境读取与适配器接线，不包含业务逻辑；业务仍在
FrontSyncEngine 与 TailLifecycle 中。消息事件发布方与 follow 模式
默认保持一次性轮询语义，事件化接线由调用方按需传入。
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Callable
from uuid import UUID

import psycopg

from notalone.front_sync import (
    CliBindingCoordinator,
    CliBackgroundSync,
    CliFullSyncEngine,
    ForegroundLocator,
    MacosFrontSessionProbe,
    TailLifecycle,
)
from notalone.front_sync.event_publisher import MessageEventPublisher
from notalone.front_sync.incremental_remote import (
    IncrementalReadOnlyState,
    RemoteIncrementalBackground,
    configured_history_runtime,
    incremental_transfer_enabled,
)
from notalone.front_sync.sync_engine import FrontSyncEngine
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.sync_scope import PostgresSyncScopeStore
from notalone.front_sync.wechat_scope_remote import RemoteWechatScope, RemoteHistoryAuthorization
from notalone.persistence.backfill_state import PostgresBackfillStateStore
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.history_authorization import (
    HistoryAuthorizationStorePort,
    PostgresHistorySyncAuthorizationStore,
)
from notalone.persistence.history_sync_state import PostgresHistorySyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.wechat_cli import LocalWechatCli


CHANNEL = "wechat"


def build_cli_full_sync_engine(
    *,
    database_url: str,
    owner_id: UUID,
    account_scope: str,
    cli_executable: str | None = None,
    probe_executable: str | None = None,
    message_events: MessageEventPublisher | None = None,
    history_authorization: HistoryAuthorizationStorePort | None = None,
    clock: Callable[[], datetime] | None = None,
) -> CliFullSyncEngine:
    """装配 CLI 后台全量同步与前台 OCR 定位双通道引擎。"""

    history_owner = configured_history_runtime(os.environ)
    incremental_enabled = incremental_transfer_enabled(os.environ)
    if history_owner == "typescript" and not incremental_enabled:
        raise ValueError("history_runtime_incremental_required")
    incremental_url = os.environ.get("NOTALONE_SYNC_INCREMENTAL_URL")
    incremental_token = os.environ.get("NOTALONE_SYNC_INCREMENTAL_TOKEN")
    remote_url = os.environ.get("NOTALONE_WECHAT_SCOPE_URL")
    remote_token = os.environ.get("NOTALONE_WECHAT_SCOPE_TOKEN")
    if (remote_url is None) != (remote_token is None):
        raise ValueError("wechat_scope_remote_config_incomplete")
    scope_store = (
        RemoteWechatScope(url=remote_url, token=remote_token, owner_id=owner_id,
                          account_scope=account_scope)
        if remote_url is not None else PostgresSyncScopeStore(database_url)
    )

    if incremental_enabled and not isinstance(scope_store, RemoteWechatScope):
        raise ValueError("sync_incremental_remote_scope_required")

    # 移交后不能通过旧账号级注入恢复历史全范围读取。
    authorization = (
        RemoteHistoryAuthorization(scope_store)
        if isinstance(scope_store, RemoteWechatScope)
        else history_authorization or PostgresHistorySyncAuthorizationStore(database_url)
    )

    cli = LocalWechatCli(
        executable=cli_executable
        or os.environ.get("NOTALONE_WECHAT_CLI", "").strip()
        or "wechat-cli"
    )
    probe = MacosFrontSessionProbe(
        executable=probe_executable
        or os.environ.get("NOTALONE_SYNC_PROBE", "").strip()
        or "notalone-sync-probe"
    )
    bindings = PostgresConversationBindingRepository(database_url)
    observation_store = PostgresObservationStore(database_url)
    sync_state = PostgresFrontSyncStateStore(database_url)
    if incremental_enabled:
        sync_state = IncrementalReadOnlyState(sync_state)

    lifecycle = TailLifecycle(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        cli=cli,
        bindings=bindings,
        observation_store=observation_store,
        sync_state=sync_state,
        message_events=message_events,
        follow_enabled=False,
    )
    fallback = FrontSyncEngine(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        probe=probe,
        lifecycle=lifecycle,
        bindings=bindings,
        sync_state=sync_state,
        cli=cli,
    )
    def cli_background(*, history_only: bool) -> CliBackgroundSync:
        return CliBackgroundSync(
            owner_id=owner_id,
            channel=CHANNEL,
            account_scope=account_scope,
            cli=cli,
            bindings=bindings,
            observation_store=observation_store,
            backfill_state=PostgresBackfillStateStore(database_url),
            history_state=PostgresHistorySyncStateStore(database_url),
            history_authorization=authorization,
            history_only=history_only,
            sync_state=sync_state,
            message_events=message_events,
            clock=clock,
        )

    if not incremental_enabled:
        background = cli_background(history_only=False)
    else:
        local_history = cli_background(history_only=True) if history_owner == "python" else None
        background = RemoteIncrementalBackground(
            url=incremental_url, token=incremental_token, owner_id=owner_id,
            account_scope=account_scope, history=local_history,
        )
    foreground = ForegroundLocator(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        probe=probe,
        cli=cli,
        bindings=bindings,
    )
    binding_coordinator = CliBindingCoordinator(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        cli=cli,
        bindings=bindings,
        batch_repository=bindings,
        clock=clock,
    )
    return CliFullSyncEngine(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        cli=cli,
        sync_state=sync_state,
        background=background,
        foreground=foreground,
        binding_coordinator=binding_coordinator,
        fallback=fallback,
        scope_store=scope_store,
        history_authorization=authorization,
        clock=clock,
    )


def owner_wechat_account_scope(database_url: str, owner_id: UUID) -> str | None:
    """读取 owner 的 active 微信渠道身份作为账号范围。"""

    with psycopg.connect(database_url) as connection:
        row = connection.execute(
            """
            SELECT external_id
            FROM public.owner_channel_identity
            WHERE owner_id = %s AND channel = 'wechat' AND status = 'active'
            LIMIT 1
            """,
            (owner_id,),
        ).fetchone()
    return None if row is None else row[0]
