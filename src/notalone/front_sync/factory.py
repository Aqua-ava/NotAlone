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
from notalone.front_sync.sync_engine import FrontSyncEngine
from notalone.persistence.conversation_repository import (
    PostgresConversationBindingRepository,
)
from notalone.persistence.backfill_state import PostgresBackfillStateStore
from notalone.persistence.front_sync_state import PostgresFrontSyncStateStore
from notalone.persistence.observation_store import PostgresObservationStore
from notalone.wechat_cli import LocalWechatCli


CHANNEL = "wechat"


def build_front_sync_engine(
    *,
    database_url: str,
    owner_id: UUID,
    account_scope: str,
    cli_executable: str | None = None,
    probe_executable: str | None = None,
    message_events: MessageEventPublisher | None = None,
    follow_enabled: bool = False,
    clock: Callable[[], float] | None = None,
) -> FrontSyncEngine:
    """按受控配置装配一个面向 owner/账号范围的前台同步引擎。"""

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
    sync_state = PostgresFrontSyncStateStore(database_url)
    lifecycle_kwargs: dict[str, object] = {
        "owner_id": owner_id,
        "channel": CHANNEL,
        "account_scope": account_scope,
        "cli": cli,
        "bindings": bindings,
        "observation_store": PostgresObservationStore(database_url),
        "sync_state": sync_state,
        "message_events": message_events,
        "follow_enabled": follow_enabled,
    }
    if clock is not None:
        # TailLifecycle 默认使用 time.time；只有显式传入时钟时才覆盖。
        lifecycle_kwargs["clock"] = clock
    lifecycle = TailLifecycle(**lifecycle_kwargs)
    return FrontSyncEngine(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        probe=probe,
        lifecycle=lifecycle,
        bindings=bindings,
        sync_state=sync_state,
        cli=cli,
    )


def build_cli_full_sync_engine(
    *,
    database_url: str,
    owner_id: UUID,
    account_scope: str,
    cli_executable: str | None = None,
    probe_executable: str | None = None,
    message_events: MessageEventPublisher | None = None,
    clock: Callable[[], datetime] | None = None,
) -> CliFullSyncEngine:
    """装配 CLI 后台全量同步与前台 OCR 定位双通道引擎。"""

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
    background = CliBackgroundSync(
        owner_id=owner_id,
        channel=CHANNEL,
        account_scope=account_scope,
        cli=cli,
        bindings=bindings,
        observation_store=observation_store,
        backfill_state=PostgresBackfillStateStore(database_url),
        sync_state=sync_state,
        message_events=message_events,
        clock=clock,
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
