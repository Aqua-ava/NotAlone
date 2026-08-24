"""本地后端服务启动命令。"""

from __future__ import annotations

import argparse
import os
import sys
from uuid import UUID

from notalone.runtime_config import load_project_env
from notalone.server.app import BackendServer, create_app


def main(argv: list[str] | None = None) -> int:
    """启动只绑定回环地址的常驻后端。"""

    load_project_env()
    parser = argparse.ArgumentParser(prog="notalone-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=0, type=int)
    args = parser.parse_args(argv)
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not database_url or not owner_value:
        print("缺少本地后端所需的数据库或 owner 配置。", file=sys.stderr)
        return 2
    try:
        owner_id = UUID(owner_value)
        app = create_app(database_url=database_url, owner_id=owner_id)
        server = BackendServer(app, host=args.host, port=args.port)
        host, port = server.start()
    except (TypeError, ValueError):
        print("本地后端配置无效。", file=sys.stderr)
        return 2
    print(f"address={host}:{port} token={app.token}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
