"""本地后端服务启动命令。"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from uuid import UUID

from notalone.front_sync.factory import (
    build_front_sync_engine,
    owner_wechat_account_scope,
)
from notalone.application.setup_service import SetupService
from notalone.runtime_config import load_project_env
from notalone.server.app import BackendServer, create_app
from notalone.server.connection_info import (
    has_active_backend,
    remove_backend_info,
    write_backend_info,
)
from notalone.server.event_bus import EventBus
from notalone.server.event_publisher import EventBusMessagePublisher
from notalone.server.follow_smoke import (
    FollowSmokeController,
    PostgresFollowSmokeSnapshotReader,
)
from notalone.server.reply_wiring import build_reply_service
from notalone.server.sync_host import SyncHost


def main(argv: list[str] | None = None) -> int:
    """启动只绑定回环地址的常驻后端。"""

    load_project_env()
    parser = argparse.ArgumentParser(prog="notalone-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=0, type=int)
    parser.add_argument(
        "--sync-interval",
        default=3.0,
        type=float,
        help="同步心跳间隔（秒），默认 3.0。",
    )
    args = parser.parse_args(argv)
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url:
        print("缺少本地后端所需的数据库配置。", file=sys.stderr)
        return 2
    try:
        owner_id = UUID(owner_value) if owner_value else None
    except ValueError:
        print("本地后端配置无效。", file=sys.stderr)
        return 2

    if has_active_backend():
        # ADR-020：一次只能有一个后端实例驱动同步；第二个实例拒绝启动。
        print("已有后端实例在运行；请退出旧实例或直接连接既有服务。", file=sys.stderr)
        return 2

    events = EventBus()
    setup_service = _build_setup_service(database_url)
    sync_host = _build_sync_host(
        database_url=database_url,
        owner_id=owner_id,
        interval=args.sync_interval,
        events=events,
    )
    follow_smoke = (
        FollowSmokeController(
            owner_id=owner_id,
            host=sync_host,
            snapshots=PostgresFollowSmokeSnapshotReader(database_url),
        )
        if owner_id is not None and sync_host is not None
        else None
    )
    reply_service = (
        build_reply_service(database_url=database_url, owner_id=owner_id)
        if owner_id is not None
        else None
    )
    memory_service = _build_memory_service(database_url)
    import_service = _build_import_service(database_url)
    task_host = _build_task_host(database_url, events)
    skill_service = _build_skill_service(database_url)
    ledger_service = _build_ledger_service(database_url)
    server: BackendServer | None = None
    try:
        app = create_app(
            database_url=database_url,
            owner_id=owner_id,
            events=events,
            sync_control=sync_host,
            reply_service=reply_service,
            memory_service=memory_service,
            import_service=import_service,
            task_host=task_host,
            skill_service=skill_service,
            ledger_service=ledger_service,
            setup_service=setup_service,
            follow_smoke=follow_smoke,
        )
        server = BackendServer(app, host=args.host, port=args.port)
        host, port = server.start()
    except (TypeError, ValueError):
        if sync_host is not None:
            sync_host.stop()
        print("本地后端配置无效。", file=sys.stderr)
        return 2
    if owner_id is None:
        print(
            "owner 尚未初始化；首启向导请使用 /api/setup 端点。",
            file=sys.stderr,
        )
    if sync_host is None and owner_id is not None:
        print(
            "owner 还没有微信渠道身份；同步端点返回 sync_unavailable。",
            file=sys.stderr,
        )
    assert server is not None
    try:
        if sync_host is not None:
            sync_host.start()
        write_backend_info(address=f"{host}:{port}", token=app.token)
        print(f"address={host}:{port} token={app.token}", flush=True)
        _serve_until_stopped(server)
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        if sync_host is not None:
            sync_host.stop()
        remove_backend_info()
        server.shutdown()


def _serve_until_stopped(server: BackendServer) -> None:
    """在子线程里 serve，主线程响应 SIGTERM/KeyboardInterrupt 后关停。

    BaseHTTPRequestHandler 的 shutdown() 必须在 serve_forever 之外的
    线程调用，否则自锁；因此把服务循环放到子线程，让主线程的信号
    处理器可以安全关停服务器。这样主窗口 App 退出时发送的 SIGTERM
    一定走完 finally 中的握手文件清理。
    """

    server_thread = threading.Thread(
        target=server.serve_forever,
        name="notalone-http-server",
        daemon=True,
    )
    server_thread.start()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: server.shutdown())
    # 主线程等待服务循环结束；SIGTERM 处理器调用 shutdown() 使其返回。
    server_thread.join()


def _build_setup_service(database_url: str) -> SetupService | None:
    """装配首启向导服务；owner 目录不可用时返回 None。"""

    from notalone.application.setup_service import SetupService
    from notalone.persistence.setup_owner_directory import (
        PostgresOwnerDirectory,
    )

    try:
        return SetupService(owner_directory=PostgresOwnerDirectory(database_url))
    except Exception:
        return None


def _build_sync_host(
    *,
    database_url: str,
    owner_id: UUID | None,
    interval: float,
    events: EventBus,
) -> SyncHost | None:
    """有微信渠道身份时装配同步宿主；否则返回 None（同步不可用）。"""

    if owner_id is None:
        return None
    account_scope = owner_wechat_account_scope(
        database_url=database_url,
        owner_id=owner_id,
    )
    if account_scope is None:
        return None
    engine = build_front_sync_engine(
        database_url=database_url,
        owner_id=owner_id,
        account_scope=account_scope,
        # 消息写入即发布 message.created 事件，供界面消息流实时更新。
        # 读取主路径仍保持一次性轮询；只有 App 的人工验证页会显式切换
        # 到 follow 优先模式，验证结束后恢复这里的默认策略。
        message_events=EventBusMessagePublisher(events),
        follow_enabled=False,
    )
    return SyncHost(engine=engine, interval=interval)


def _build_memory_service(database_url: str) -> MemoryService:
    """装配记忆管理服务（联系人级 + owner 级）。"""

    from notalone.application.memory_service import MemoryService
    from notalone.persistence import (
        PostgresMemoryStore,
        PostgresOwnerMemoryStore,
    )

    return MemoryService(
        contact_memory=PostgresMemoryStore(database_url),
        owner_memory=PostgresOwnerMemoryStore(database_url),
    )


def _build_import_service(database_url: str) -> ImportService | None:
    """装配导入服务；仓库不可用时返回 None。"""

    from notalone.application.import_service import ImportService
    from notalone.persistence.postgres_repository import (
        PostgresIngestRepository,
    )

    try:
        return ImportService(repository=PostgresIngestRepository(database_url))
    except Exception:
        return None


def _build_task_host(database_url: str, events: EventBus) -> TaskHost | None:
    """装配进程内任务宿主；模型或数据库配置不可用时返回 None。"""

    import psycopg

    from notalone.application.import_service import TaskHost
    from notalone.server.event_models import BackendEvent
    from notalone.tasks.command import DEFAULT_WORKER_LEASE_DURATION
    from notalone.tasks.worker import (
        PostgresMemoryExtractionRunner,
        BackgroundTaskWorker,
    )
    from notalone.persistence.background_tasks import (
        PostgresBackgroundTaskRepository,
    )
    from notalone.persistence.contact_memory_index import (
        PostgresContactMemoryIndexRepository,
    )
    from notalone.scopes import ContactScope

    def build_worker() -> BackgroundTaskWorker:
        return BackgroundTaskWorker(
            repository=PostgresBackgroundTaskRepository(database_url),
            extraction_runner=PostgresMemoryExtractionRunner(database_url),
            lease_duration=DEFAULT_WORKER_LEASE_DURATION,
            index_repository=PostgresContactMemoryIndexRepository(database_url),
        )

    def build_lock_connection():
        return psycopg.connect(database_url, autocommit=True)

    def publish_progress(update) -> None:
        """把一次任务进度更新发布为 TASK_PROGRESS 事件。"""

        from datetime import datetime, timezone

        events.publish(
            BackendEvent.task_progress(
                scope=ContactScope(
                    owner_id=update.owner_id,
                    contact_id=update.contact_id,
                ),
                occurred_at=datetime.now(timezone.utc),
                task_id=update.task_id,
                step=update.step,
                status=update.status,
                processed_count=update.processed_count,
                attempt_count=update.attempt_count,
                retry_count=update.retry_count,
            )
        )

    try:
        return TaskHost(
            worker_builder=build_worker,
            lock_connection_builder=build_lock_connection,
            event_publisher=publish_progress,
        )
    except Exception:
        return None


def _build_skill_service(database_url: str) -> SkillService | None:
    """装配 Skill 管理服务；仓库不可用时返回 None。"""

    from notalone.application.skill_service import SkillService
    from notalone.persistence.skill_library import PostgresSkillLibrary

    try:
        return SkillService(
            management=PostgresSkillLibrary(database_url)
        )
    except Exception:
        return None


def _build_ledger_service(database_url: str) -> LedgerService | None:
    """装配出站台账概览服务；仓库不可用时返回 None。"""

    from notalone.application.skill_service import LedgerService
    from notalone.persistence.outbound_ledger import PostgresOutboundLedger

    try:
        return LedgerService(ledger=PostgresOutboundLedger(database_url))
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
