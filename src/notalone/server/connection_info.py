"""后端连接信息的本机握手文件读写。

主窗口 App 拉起常驻后端并解析其 stdout，而菜单栏是独立进程，
需要通过一个固定路径发现后端的 address 与 token。文件权限 0600，
不落入仓库；路径可用 ``NOTALONE_BACKEND_INFO`` 覆盖，默认
``~/.notalone/backend.info``。
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

INFO_FILE_VARIABLE = "NOTALONE_BACKEND_INFO"
DEFAULT_INFO_PATH = "~/.notalone/backend.info"


def backend_info_path() -> Path:
    """返回连接信息文件的路径；受环境变量覆盖。"""

    configured = os.environ.get(INFO_FILE_VARIABLE, "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(DEFAULT_INFO_PATH).expanduser()


def write_backend_info(*, address: str, token: str, pid: int | None = None) -> Path:
    """把后端监听地址、随机 token 与进程号原子写入握手文件。"""

    if not address or not token:
        raise ValueError("address 与 token 都不能为空。")
    process_id = os.getpid() if pid is None else pid
    if not isinstance(process_id, int) or process_id <= 0:
        raise ValueError("pid 必须是正整数。")
    path = backend_info_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = temporary.name
            os.chmod(temporary.name, 0o600)
            temporary.write(f"address={address}\n")
            temporary.write(f"token={token}\n")
            temporary.write(f"pid={process_id}\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
    except OSError:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
        raise
    return path


def remove_backend_info() -> Path:
    """删除握手文件；不存在时无操作。"""

    path = backend_info_path()
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return path


def has_active_backend() -> bool:
    """握手文件里的 pid 仍存活时视为已有后端实例在运行。

    用于落实 ADR-020「一次只能有一个后端实例驱动同步」：第二个
    实例启动前检查既有实例；文件残留但进程已退出时返回 False。
    仅本机回环环境使用，不做网络探测。
    """

    path = backend_info_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return False
    process_id: int | None = None
    for line in lines:
        if line.startswith("pid="):
            try:
                process_id = int(line.removeprefix("pid="))
            except ValueError:
                process_id = None
            break
    if process_id is None or process_id <= 0:
        return False
    try:
        os.kill(process_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # 进程属于其他用户（权限不足探测）：保守视为活跃。
        return True
    return True