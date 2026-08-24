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
from notalone.runtime_config import load_project_env
from notalone.server.app import BackendServer, create_app
from notalone.server.connection_info import (
    has_active_backend,
    remove_backend_info,
    write_backend_info,
)
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
    if not database_url or not owner_value:
        print("缺少本地后端所需的数据库或 owner 配置。", file=sys.stderr)
        return 2
    try:
        owner_id = UUID(owner_value)
    except ValueError:
        print("本地后端配置无效。", file=sys.stderr)
        return 2

    if has_active_backend():
        # ADR-020：一次只能有一个后端实例驱动同步；第二个实例拒绝启动。
        print("已有后端实例在运行；请退出旧实例或直接连接既有服务。", file=sys.stderr)
        return 2

    sync_host = _build_sync_host(
        database_url=database_url,
        owner_id=owner_id,
        interval=args.sync_interval,
    )
    server: BackendServer | None = None
    try:
        app = create_app(
            database_url=database_url,
            owner_id=owner_id,
            sync_control=sync_host,
        )
        server = BackendServer(app, host=args.host, port=args.port)
        host, port = server.start()
    except (TypeError, ValueError):
        if sync_host is not None:
            sync_host.stop()
        print("本地后端配置无效。", file=sys.stderr)
        return 2
    if sync_host is None:
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


def _build_sync_host(
    *,
    database_url: str,
    owner_id: UUID,
    interval: float,
) -> SyncHost | None:
    """有微信渠道身份时装配同步宿主；否则返回 None（同步不可用）。"""

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
    )
    return SyncHost(engine=engine, interval=interval)


if __name__ == "__main__":
    raise SystemExit(main())