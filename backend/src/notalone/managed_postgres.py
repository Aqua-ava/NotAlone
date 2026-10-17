"""包内 PostgreSQL 的窄寿命监督入口；仅持有本次创建的子进程。"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

from notalone.parent_lifetime import ParentLifetime, private_lifetime_file


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres", required=True)
    parser.add_argument("--data-directory", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--parent-pid", required=True, type=int)
    parser.add_argument("--lifetime-lock", required=True)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535 or not all(Path(value).is_absolute() for value in (args.postgres, args.data_directory, args.lifetime_lock)):
        return 2
    stopped = threading.Event()
    with ParentLifetime(args.parent_pid, exit_timeout=None) as lifetime, private_lifetime_file(args.lifetime_lock, create=True) as lock:
        lifetime.on_exit(stopped.set)
        signal.signal(signal.SIGINT, lambda *_: stopped.set())
        signal.signal(signal.SIGTERM, lambda *_: stopped.set())
        child: subprocess.Popen[bytes] | None = None

        def launch() -> None:
            nonlocal child
            child = subprocess.Popen([args.postgres, "-D", args.data_directory, "-h", "127.0.0.1", "-p", str(args.port),
                                      "-c", "unix_socket_directories=", "-c", "password_encryption=scram-sha-256", "-c", "logging_collector=off"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if not lifetime.start_if_alive(launch) or child is None:
                return 2
            print(json.dumps({"pid": child.pid}), flush=True)
            while child.poll() is None and not stopped.wait(0.1):
                pass
            if child.poll() is None:
                # 后台持有共享寿命锁直到停止读取和清理握手；PG 随后才关闭。
                fcntl.flock(lock, fcntl.LOCK_EX)
                child.send_signal(signal.SIGINT)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.send_signal(signal.SIGQUIT)
                    child.wait()
            return child.returncode or 0
        finally:
            Path(args.lifetime_lock).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        print("资料服务监督启动失败。", file=sys.stderr)
        raise SystemExit(2)
