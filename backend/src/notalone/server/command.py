"""本地后端服务启动命令。"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from typing import TYPE_CHECKING
from uuid import UUID

if TYPE_CHECKING:
    # 装配函数内仍按需局部导入，避免启动路径拉起全部应用服务；
    # 这里只为注解提供名字，运行时不求值。
    from notalone.application.import_service import ImportService
    from notalone.application.memory_service import MemoryService
    from notalone.application.skill_service import LedgerService, SkillService

from notalone.front_sync.factory import (
    build_cli_full_sync_engine,
    owner_wechat_account_scope,
)
from notalone.application.setup_service import SetupService
from notalone.application.import_service import TaskHost
from notalone.application.model_priority import (
    AccountedExtractionRunner, MemoryCallAccounting,
    ModelPriorityControl, PriorityAdjudicationRuntime, PriorityExtractionRuntime,
    PriorityVerificationRuntime,
)
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.runtime_config import load_project_env
from notalone.parent_lifetime import ParentLifetime
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

    parser = argparse.ArgumentParser(prog="notalone-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=0, type=int)
    parser.add_argument("--parent-pid", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--lifetime-lock", help=argparse.SUPPRESS)
    parser.add_argument(
        "--sync-interval",
        default=3.0,
        type=float,
        help="同步心跳间隔（秒），默认 3.0。",
    )
    args = parser.parse_args(argv)
    try:
        with ParentLifetime(args.parent_pid, args.lifetime_lock) as lifetime:
            return _run(args, lifetime)
    except (OSError, ValueError):
        print("本地后端启动者已经退出或寿命信息无效。", file=sys.stderr)
        return 2


def _run(args: argparse.Namespace, lifetime: ParentLifetime) -> int:
    load_project_env()
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
    model_priority = ModelPriorityControl()
    setup_service = _build_setup_service(database_url)
    from notalone.application.organization_runtime import build_layered_memory_service
    try:
        layered_memory = build_layered_memory_service(database_url, model_priority=model_priority)
    except (OSError, ValueError, RuntimeError):
        model_priority.stop()
        print('本地整理质量operator配置无效。', file=sys.stderr)
        return 2
    task_host = _build_task_host(database_url, events, model_priority=model_priority,organization_runner=layered_memory)
    layered_memory.attach_task_host(task_host)
    sync_host = _build_sync_host(
        database_url=database_url,
        owner_id=owner_id,
        interval=args.sync_interval,
        events=events,
        task_host=task_host,
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
        build_reply_service(
            database_url=database_url, owner_id=owner_id, model_priority=model_priority,
        )
        if owner_id is not None
        else None
    )
    memory_service = _build_memory_service(database_url)
    import_service = _build_import_service(database_url)
    skill_service = _build_skill_service(database_url)
    ledger_service = _build_ledger_service(database_url)
    server: BackendServer | None = None

    def stop_runtime() -> None:
        # 共享一个等待预算；同步收尾与任务收尾不能依次各等一轮。
        model_priority.stop()
        deadline = time.monotonic() + 4.0
        sync_thread = None
        if sync_host is not None:
            sync_thread = threading.Thread(target=sync_host.stop, daemon=True)
            sync_thread.start()
        if task_host is not None:
            task_host.stop(timeout=max(0.0, deadline - time.monotonic()))
        if sync_thread is not None:
            sync_thread.join(timeout=max(0.0, deadline - time.monotonic()))
    try:
        app = create_app(
            database_url=database_url,
            owner_id=owner_id,
            events=events,
            sync_control=sync_host,
            reply_service=reply_service,
            memory_service=memory_service,
            layered_memory=layered_memory,
            import_service=import_service,
            task_host=task_host,
            skill_service=skill_service,
            ledger_service=ledger_service,
            setup_service=setup_service,
            follow_smoke=follow_smoke,
            runtime_shutdown=stop_runtime,
        )
        server = BackendServer(app, host=args.host, port=args.port)
        host, port = server.start()
    except (TypeError, ValueError):
        stop_runtime()
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
        def start_reading() -> None:
            if sync_host is not None:
                sync_host.start()
            write_backend_info(address=f"{host}:{port}", token=app.token)
            print(f"address={host}:{port} token={app.token}", flush=True)

        _serve_until_stopped(server, lifetime, start_reading)
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        remove_backend_info()
        server.shutdown()


def _serve_until_stopped(
    server: BackendServer, lifetime: ParentLifetime | None = None,
    start_reading: Callable[[], None] | None = None,
) -> None:
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
    signal.signal(signal.SIGTERM, lambda _signum, _frame: server.request_shutdown())
    if lifetime is not None:
        lifetime.on_exit(server.request_shutdown)
        if callable(start_reading) and not lifetime.start_if_alive(start_reading):
            server.request_shutdown()
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
    task_host: TaskHost | None = None,
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
    from notalone.application.skill_learning import SkillLearningService
    from notalone.persistence.skill_learning import PostgresSkillLearningStore
    learning = SkillLearningService(PostgresSkillLearningStore(database_url), task_host=task_host)
    engine = build_cli_full_sync_engine(
        database_url=database_url,
        owner_id=owner_id,
        account_scope=account_scope,
        # 消息提交后发布事件，并复验观察来源后唤醒同联系人的记忆任务。
        # 正常主路径由全局 CLI 后台同步驱动；人工验证页仍可显式使用
        # 旧的前台 Follow 兜底流程，不改变正式同步开关。
        message_events=EventBusMessagePublisher(
            events, owner_id=owner_id, task_host=task_host,
            learning_notify=learning.notify,
        ),
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


def _build_task_host(
    database_url: str, events: EventBus,
    *, model_priority: ModelPriorityControl | None = None,
    dimension_release: DimensionRelease | None = None,
    organization_runner=None,
) -> TaskHost | None:
    """装配任务宿主；执行前再检查模型与资源，不提前领取持久任务。"""

    import psycopg

    from notalone.application.import_service import TaskHost
    from notalone.server.event_models import BackendEvent
    from notalone.tasks.command import DEFAULT_WORKER_LEASE_DURATION
    from notalone.tasks.worker import (
        ExtractionTaskRunner,
        PostgresMemoryExtractionRunner,
        BackgroundTaskWorker,
    )
    from notalone.persistence.background_tasks import (
        PostgresBackgroundTaskRepository,
    )
    from notalone.persistence.contact_memory_index import (
        PostgresContactMemoryIndexRepository,
    )
    from notalone.persistence.source_deletion import PostgresSourceDeletionRepository
    from notalone.scopes import ContactScope
    from notalone.memory_extraction.grounded_adapter import GroundedExtractionRuntime
    from notalone.memory_extraction.adjudication_adapters import LangChainAdjudicationRuntime
    from notalone.memory_extraction.cli_support import build_extraction_components
    from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
    from notalone.application.skill_learning import SkillLearningTaskRunner
    from notalone.persistence.skill_learning import PostgresSkillLearningStore
    from notalone.skills.learning_runtime import LangChainSkillProposalRuntime
    from notalone.application.memory_upgrade import MemoryUpgradeTaskRunner
    from notalone.application.memory_upgrade_runtime import UpgradeRuntimeBuilder
    from notalone.persistence.memory_upgrade import PostgresMemoryUpgradeStore
    from notalone.persistence.extraction_trace import PostgresExtractionTraceStore

    upgrade_runtime = UpgradeRuntimeBuilder(database_url, dimension_release=dimension_release)

    def build_worker() -> BackgroundTaskWorker:
        extraction: ExtractionTaskRunner
        components = None
        if model_priority is None:
            extraction = PostgresMemoryExtractionRunner(
                database_url, dimension_release=dimension_release,
            )
        else:
            components = build_extraction_components(database_url)
            accounting = MemoryCallAccounting(
                components.ledger, model_name=components.model_name,
            )
            extraction = AccountedExtractionRunner(PostgresMemoryExtractionRunner(
                database_url,
                runtime=PriorityExtractionRuntime(
                    GroundedExtractionRuntime(model=components.model), model_priority,
                    accounting=accounting,
                ),
                verification_runtime=PriorityVerificationRuntime(
                    LangChainSourceVerificationRuntime(
                        model=components.model, ledger=components.ledger, provider="deepseek",
                    ), model_priority,
                ),
                adjudication_runtime=PriorityAdjudicationRuntime(
                    LangChainAdjudicationRuntime(model=components.model), model_priority,
                    accounting=accounting,
                ),
                ledger=components.ledger, watermark_port=components.watermark,
                model_name=components.model_name,
                # 生产 main 沿用 None；合成验收显式注入放行维度。
                dimension_release=dimension_release,
            ), accounting)
        def build_learning_runtime():
            # 学习每次 invoke 只记一笔台账，独立模型禁止 SDK 隐式重发。
            active = build_extraction_components(database_url, max_retries=0)
            return LangChainSkillProposalRuntime(model=active.model, ledger=active.ledger)

        return BackgroundTaskWorker(
            repository=PostgresBackgroundTaskRepository(database_url),
            organization_runner=organization_runner,
            extraction_runner=extraction,
            lease_duration=DEFAULT_WORKER_LEASE_DURATION,
            index_repository=PostgresContactMemoryIndexRepository(database_url),
            deletion_repository=PostgresSourceDeletionRepository(database_url),
            model_priority=model_priority,
            upgrade_runner=MemoryUpgradeTaskRunner(
                store=PostgresMemoryUpgradeStore(database_url, algorithm_provider=upgrade_runtime.identity),
                runtime_builder=upgrade_runtime, trace_store=PostgresExtractionTraceStore(database_url),
                model_priority=model_priority, dimension_release=dimension_release,
            ),
            learning_runner=SkillLearningTaskRunner(
                store=PostgresSkillLearningStore(database_url), runtime_builder=build_learning_runtime,
                model_priority=model_priority,
            ),
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
                error_code=update.error_code,
                failure_state_commit=update.failure_state_commit,
            )
        )

    try:
        return TaskHost(
            worker_builder=build_worker,
            lock_connection_builder=build_lock_connection,
            event_publisher=publish_progress,
            model_priority=model_priority,
            task_repository=PostgresBackgroundTaskRepository(database_url),
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
