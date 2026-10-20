"""原生单帧 worker 的有界 JSONL 传输；只复用进程，不缓存观察结果。"""

from __future__ import annotations

import json
import os
import select
import subprocess
from threading import Lock
from time import monotonic
from typing import Any
from uuid import uuid4


_MAX_REQUEST_BYTES = 4096
_MAX_RESPONSE_BYTES = 65536


class SessionWorkerError(RuntimeError):
    """仅携带稳定代码；子进程输出不进入异常或日志。"""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class NativeSessionWorker:
    """一个在途请求、一个可中断 worker；每轮都重新请求采集。"""

    def __init__(self, executable: str) -> None:
        self._executable = executable
        self._request_lock = Lock()
        self._state_lock = Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._generation = 0

    def observe(self, *, timeout_seconds: float) -> dict[str, Any]:
        deadline = monotonic() + timeout_seconds
        with self._state_lock:
            generation = self._generation
        if not self._request_lock.acquire(timeout=max(0.0, deadline - monotonic())):
            self.close()
            raise SessionWorkerError("probe_timeout")
        process: subprocess.Popen[bytes] | None = None
        try:
            process = self._ensure_process(generation=generation, deadline=deadline)
            request_id = str(uuid4())
            request = json.dumps({
                "version": 1, "request_id": request_id, "operation": "observe",
            }, separators=(",", ":")).encode("utf-8") + b"\n"
            if len(request) > _MAX_REQUEST_BYTES:
                raise SessionWorkerError("probe_output_invalid")
            self._write(process, request, generation=generation, deadline=deadline)
            envelope = self._read(process, generation=generation, deadline=deadline)
            if (set(envelope) != {"version", "request_id", "result"}
                    or type(envelope["version"]) is not int or envelope["version"] != 1
                    or envelope["request_id"] != request_id
                    or not isinstance(envelope["result"], dict)):
                raise SessionWorkerError("probe_output_invalid")
            self._check_current(process, generation=generation, deadline=deadline)
            return envelope["result"]
        except FileNotFoundError:
            raise SessionWorkerError("probe_not_found") from None
        except SessionWorkerError:
            if process is not None:
                self._discard(process)
            raise
        except (OSError, ValueError, subprocess.SubprocessError):
            if process is not None:
                self._discard(process)
            raise SessionWorkerError("probe_failed") from None
        finally:
            self._request_lock.release()

    def close(self) -> None:
        """不等待请求锁；停用时中断等待中的读写，下次显式请求可重建。"""

        with self._state_lock:
            self._generation += 1
            process, self._process = self._process, None
        if process is not None:
            self._stop(process)

    def _ensure_process(
        self, *, generation: int, deadline: float,
    ) -> subprocess.Popen[bytes]:
        with self._state_lock:
            if generation != self._generation:
                raise SessionWorkerError("probe_failed")
            process = self._process
        if process is not None:
            try:
                if process.poll() is None and not self._idle_eof(process):
                    return process
            except BaseException:
                self._discard(process)
                raise
            self._discard(process)
        if monotonic() >= deadline:
            raise SessionWorkerError("probe_timeout")
        process = subprocess.Popen(
            (self._executable, "--session-worker", "--json"),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0, close_fds=True,
        )
        with self._state_lock:
            stale = generation != self._generation
            if not stale:
                self._process = process
        if stale:
            self._stop(process)
            raise SessionWorkerError("probe_failed")
        try:
            assert process.stdin is not None and process.stdout is not None
            os.set_blocking(process.stdin.fileno(), False)
            os.set_blocking(process.stdout.fileno(), False)
            ready = self._read(process, generation=generation, deadline=deadline)
            if (set(ready) != {"version", "event"} or type(ready["version"]) is not int
                    or ready["version"] != 1 or ready["event"] != "ready"):
                raise SessionWorkerError("probe_output_invalid")
            return process
        except BaseException:
            self._discard(process)
            raise

    @staticmethod
    def _idle_eof(process: subprocess.Popen[bytes]) -> bool:
        assert process.stdout is not None
        if not select.select([process.stdout], [], [], 0)[0]:
            return False
        data = os.read(process.stdout.fileno(), 1)
        if data:
            # 没有新请求时出现任何字节都不是下一轮可用的观察。
            raise SessionWorkerError("probe_output_invalid")
        return True

    def _check_current(
        self, process: subprocess.Popen[bytes], *, generation: int, deadline: float,
    ) -> None:
        with self._state_lock:
            if generation != self._generation or self._process is not process:
                raise SessionWorkerError("probe_failed")
        if monotonic() >= deadline:
            raise SessionWorkerError("probe_timeout")

    def _write(
        self, process: subprocess.Popen[bytes], data: bytes, *, generation: int, deadline: float,
    ) -> None:
        assert process.stdin is not None
        offset = 0
        while offset < len(data):
            self._check_current(process, generation=generation, deadline=deadline)
            writable = select.select([], [process.stdin], [], max(0, deadline - monotonic()))[1]
            if not writable:
                raise SessionWorkerError("probe_timeout")
            try:
                count = os.write(process.stdin.fileno(), data[offset:])
            except BlockingIOError:
                continue
            if count <= 0:
                raise SessionWorkerError("probe_failed")
            offset += count

    def _read(
        self, process: subprocess.Popen[bytes], *, generation: int, deadline: float,
    ) -> dict[str, Any]:
        assert process.stdout is not None
        data = bytearray()
        while True:
            self._check_current(process, generation=generation, deadline=deadline)
            readable = select.select([process.stdout], [], [], max(0, deadline - monotonic()))[0]
            if not readable:
                raise SessionWorkerError("probe_timeout")
            try:
                chunk = os.read(process.stdout.fileno(), min(4096, _MAX_RESPONSE_BYTES - len(data)))
            except BlockingIOError:
                continue
            if not chunk:
                raise SessionWorkerError("probe_failed")
            data.extend(chunk)
            if b"\n" in data:
                if not data.endswith(b"\n") or data.count(b"\n") != 1:
                    raise SessionWorkerError("probe_output_invalid")
                break
            if len(data) >= _MAX_RESPONSE_BYTES:
                raise SessionWorkerError("probe_output_invalid")
        try:
            value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_fields,
                               parse_constant=_invalid_constant)
        except (UnicodeError, ValueError, TypeError, RecursionError):
            raise SessionWorkerError("probe_output_invalid") from None
        if not isinstance(value, dict):
            raise SessionWorkerError("probe_output_invalid")
        return value

    def _discard(self, process: subprocess.Popen[bytes]) -> None:
        with self._state_lock:
            if self._process is process:
                self._process = None
        self._stop(process)

    @staticmethod
    def _stop(process: subprocess.Popen[bytes]) -> None:
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=0.1)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass


def _unique_fields(items: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in items:
        if key in value:
            raise ValueError("重复协议字段。")
        value[key] = item
    return value


def _invalid_constant(value: str) -> None:
    del value
    raise ValueError("无效协议数值。")
