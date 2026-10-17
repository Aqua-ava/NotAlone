"""App 自建后台的寿命门；不发现、接管或终止其他进程。"""

from __future__ import annotations

import fcntl
import os
import select
import stat
import threading
import time
from collections.abc import Callable
from typing import IO


def private_lifetime_file(path: str, *, create: bool = False) -> IO[bytes]:
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("运行时寿命文件无效。")
        return os.fdopen(descriptor, "r+b", buffering=0)
    except BaseException:
        os.close(descriptor)
        raise


class ParentLifetime:
    """仅监督本次启动者，管道断开或父进程消失即关闭新工作并请求收尾。"""

    def __init__(self, parent_pid: int | None, lock_path: str | None = None, *, exit_timeout: float | None = 6):
        self._parent_pid = parent_pid
        self._lock_path = lock_path
        self._file: IO[bytes] | None = None
        self._finished = threading.Event()
        self._lost = False
        self._mutex = threading.Lock()
        self._on_exit: Callable[[], None] | None = None
        self._exit_timeout = exit_timeout

    def __enter__(self) -> ParentLifetime:
        if self._parent_pid is None:
            if self._lock_path is not None:
                raise ValueError("缺少启动者。")
            return self
        if self._parent_pid <= 1 or os.getppid() != self._parent_pid:
            raise ValueError("启动者已经退出。")
        if self._lock_path:
            self._file = private_lifetime_file(self._lock_path)
            try:
                fcntl.flock(self._file, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BaseException:
                self._file.close()
                raise
        if not self.alive():
            self.__exit__(None, None, None)
            raise ValueError("启动者已经退出。")
        threading.Thread(target=self._watch, name="notalone-app-lifetime", daemon=True).start()
        return self

    def __exit__(self, *_: object) -> None:
        self._finished.set()
        if self._file and not (self._lost and self._exit_timeout is not None):
            self._file.close()
            self._file = None

    def alive(self) -> bool:
        return not self._lost and (self._parent_pid is None or os.getppid() == self._parent_pid)

    def start_if_alive(self, start: Callable[[], None]) -> bool:
        with self._mutex:
            if not self.alive():
                return False
            start()
            return True

    def on_exit(self, callback: Callable[[], None]) -> None:
        with self._mutex:
            self._on_exit = callback
            lost = not self.alive()
        if lost:
            callback()

    def _watch(self) -> None:
        while not self._finished.is_set():
            readable, _, _ = select.select([0], [], [], 0.1)
            if os.getppid() == self._parent_pid and (not readable or os.read(0, 1)):
                continue
            with self._mutex:
                self._lost = True
                callback = self._on_exit
            if callback:
                callback()
                # 正常停止预算为4秒；异常收尾不能永久占住本次PG寿命锁。
                if self._exit_timeout is not None:
                    # 非daemon工作线程也可能拖住解释器退出；进程真正结束前不释放PG门。
                    time.sleep(self._exit_timeout)
                    os._exit(2)
            elif self._exit_timeout is not None:
                # 装配期尚未开放读取，父已死时不继续创建服务。
                os._exit(2)
            return
