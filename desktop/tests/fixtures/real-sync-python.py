"""真实同步验收的解释器接缝；只缩小 CLI 范围，不替换产品运行时。"""

from __future__ import annotations

import atexit
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
import json
import math
import os
from pathlib import Path
import runpy
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Any
from zoneinfo import ZoneInfo

from notalone.wechat_cli import CliCommandError, CliOutputError, LocalWechatCli
from notalone.wechat_cli.normalizer import normalize_cli_events


@dataclass(frozen=True, slots=True)
class AcceptanceScope:
    locator: str
    real_cli: Path
    real_wcdb: Path
    sandbox_profile: Path
    audit_path: Path
    pid_audit_path: Path
    approved_texts: tuple[str, ...]
    not_before: float
    until: float


def _fail(code: str = "acceptance_scope_exceeded") -> CliCommandError:
    return CliCommandError(code, "真实同步验收边界校验失败。")


def _private_fd(path: Path, *, append: bool = False) -> int:
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT if append else os.O_RDONLY
    try:
        fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            os.close(fd)
            raise _fail("acceptance_private_file_invalid")
        return fd
    except OSError:
        raise _fail("acceptance_private_file_invalid") from None


def load_scope(path: str | Path | None = None) -> AcceptanceScope:
    """仅验证当前用户的私有声明，不读取 locator 指向的任何资料。"""

    configured = path if path is not None else os.environ.get("NOTALONE_REAL_SYNC_SCOPE", "")
    selected = Path(configured)
    if not selected.is_absolute():
        raise _fail("acceptance_scope_invalid")
    fd = _private_fd(selected)
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as file:
            text = file.read(65537)
        if len(text) > 65536:
            raise _fail("acceptance_scope_invalid")
        value = json.loads(text)
        expected = {"locator", "real_cli", "real_wcdb", "sandbox_profile", "audit_path",
                    "pid_audit_path", "approved_texts", "not_before", "until"}
        if not isinstance(value, dict) or set(value) != expected:
            raise _fail("acceptance_scope_invalid")
        locator = value["locator"]
        texts = value["approved_texts"]
        if (not isinstance(locator, str) or not locator.strip() or locator != locator.strip()
                or len(locator) > 256 or any(char.isspace() for char in locator)
                or not isinstance(texts, list) or not 1 <= len(texts) <= 16
                or any(not isinstance(item, str) or not item.strip() or len(item) > 256 for item in texts)):
            raise _fail("acceptance_scope_invalid")
        times = (value["not_before"], value["until"])
        if (any(isinstance(item, bool) or not isinstance(item, (int, float))
                or not math.isfinite(item) for item in times)
                or not 0 < times[0] < times[1] or times[1] - times[0] > 1800):
            raise _fail("acceptance_scope_invalid")
        paths = {key: Path(value[key]) for key in
                 ("real_cli", "real_wcdb", "sandbox_profile", "audit_path", "pid_audit_path")}
        if any(not item.is_absolute() or item.resolve() != item for item in paths.values()):
            raise _fail("acceptance_scope_invalid")
        if len(set(paths.values()) | {selected}) != 6:
            raise _fail("acceptance_scope_invalid")
        for key in ("real_cli", "real_wcdb", "sandbox_profile"):
            info = paths[key].lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o022
                    or (key == "real_cli" and not info.st_mode & 0o100)):
                raise _fail("acceptance_scope_invalid")
        if stat.S_IMODE(paths["sandbox_profile"].stat().st_mode) != 0o600:
            raise _fail("acceptance_scope_invalid")
        for key in ("audit_path", "pid_audit_path"):
            parent = paths[key].parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                    or stat.S_IMODE(parent.st_mode) != 0o700):
                raise _fail("acceptance_private_file_invalid")
            if paths[key].exists() or paths[key].is_symlink():
                audit_fd = _private_fd(paths[key])
                os.close(audit_fd)
        return AcceptanceScope(locator=locator, approved_texts=tuple(texts),
                               not_before=float(times[0]), until=float(times[1]), **paths)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        raise _fail("acceptance_scope_invalid") from None


class ScopeGuard:
    """在原适配器的进程接缝校验完整命令，拒绝隐式历史和写能力。"""

    def __init__(self, scope: AcceptanceScope, clock: Callable[[], float]) -> None:
        self.scope = scope
        self.clock = clock
        self.tail_cursors: set[str] = set()
        self.session_cursors: set[str] = set()

    def check_time(self) -> None:
        now = self.clock()
        if not self.scope.not_before <= now < self.scope.until:
            raise _fail("acceptance_window_expired")

    def command_kind(self, command: tuple[str, ...], *, follow: bool = False) -> str:
        self.check_time()
        if not command or command[0] != str(self.scope.real_cli):
            raise _fail()
        if not follow and command[1:] == ("--version",):
            return "version"
        if follow:
            remainder = command[2:]
            if command[1:2] != ("tail",):
                raise _fail()
            if remainder[:1] == ("--cursor",):
                if len(remainder) < 2 or remainder[1] not in self.session_cursors:
                    raise _fail()
                remainder = remainder[2:]
            if remainder != ("--mode", "sessions", "--scan-limit", "5000",
                              "--poll-interval", "3s", "--include-media-paths", "false",
                              "--follow", "--jsonl", "--strict-read-only"):
                raise _fail()
            return "sessions_follow"
        if command[1:3] != ("tail", self.scope.locator):
            raise _fail()
        if command[-3:] != ("--include-media-paths", "false", "--strict-read-only"):
            raise _fail()
        arguments = command[3:-3]
        if len(arguments) not in (2, 4):
            raise _fail()
        selector, value = arguments[:2]
        if selector == "--cursor":
            if value not in self.tail_cursors:
                raise _fail()
        elif selector == "--since-time":
            try:
                parsed = datetime.fromisoformat(value)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=ZoneInfo("Asia/Taipei"))
                if not self.scope.not_before <= parsed.timestamp() < self.scope.until:
                    raise _fail()
            except ValueError:
                raise _fail() from None
        else:
            raise _fail()
        if len(arguments) == 4 and (arguments[2] != "--limit"
                                   or not arguments[3].isascii()
                                   or not arguments[3].isdigit()
                                   or not 1 <= int(arguments[3]) <= 5000):
            raise _fail()
        return "tail"


class ScopedSessionStream:
    def __init__(self, inner: Any, guard: ScopeGuard) -> None:
        self.inner = inner
        self.guard = guard

    def __getattr__(self, key: str) -> Any:
        return getattr(self.inner, key)

    def read(self, timeout: float | None = None) -> Any:
        self.guard.check_time()
        event = self.inner.read(timeout=timeout)
        if event is not None:
            self.guard.session_cursors.add(event.cursor)
        return event


class ScopedCli:
    def __init__(self, actual: LocalWechatCli, guard: ScopeGuard,
                 close_runner: Callable[[], None],
                 reject: Callable[[str, str], None],
                 accepted: Callable[[], None]) -> None:
        self.actual = actual
        self.guard = guard
        self.close_runner = close_runner
        self.reject = reject
        self.accepted = accepted

    def tail(self, target: str, **kwargs: Any) -> Any:
        try:
            result = self.actual.tail(target, **kwargs)
        except CliOutputError:
            self.reject("tail", "acceptance_scope_exceeded")
            raise _fail() from None
        if not result.freshness_confirmed:
            self.reject("tail", "acceptance_source_unverified")
            raise _fail("acceptance_source_unverified")
        try:
            normalized = normalize_cli_events(result.events)
        except Exception:
            self.reject("tail", "acceptance_scope_exceeded")
            raise _fail() from None
        scope = self.guard.scope
        if (result.non_text_count or any(
                item.speaker != "user" or item.text_content not in scope.approved_texts
                or item.occurred_at is None
                or not scope.not_before <= item.occurred_at.timestamp() < scope.until
                for item in normalized)):
            self.reject("tail", "acceptance_scope_exceeded")
            raise _fail()
        try:
            self.guard.check_time()
        except CliCommandError as error:
            self.reject("tail", error.code)
            raise
        if result.cursor is not None:
            self.guard.tail_cursors.add(result.cursor)
        self.accepted()
        return result

    def version(self) -> str:
        return self.actual.version()

    def session_events_follow(self, **kwargs: Any) -> ScopedSessionStream:
        return ScopedSessionStream(self.actual.session_events_follow(**kwargs), self.guard)

    def close(self) -> None:
        self.actual.close()
        self.close_runner()

    def resolve_chat(self, *args: Any, **kwargs: Any) -> Any:
        self.reject("tail", "acceptance_scope_exceeded")
        raise _fail()

    def sessions(self, *args: Any, **kwargs: Any) -> Any:
        # 管理页会加载会话列表；本场沿既有绑定验收，不执行列表读取。
        self.reject("sessions", "acceptance_session_listing_blocked")
        raise _fail("acceptance_session_listing_blocked")

    def tail_follow(self, *args: Any, **kwargs: Any) -> Any:
        self.reject("tail", "acceptance_scope_exceeded")
        raise _fail()


class ManagedProcess:
    """保留真实子进程身份，终止和 wait 后只记录一次无正文退出事件。"""

    def __init__(self, process: Any, kind: str, owner: AuditedProcesses) -> None:
        self.process = process
        self.kind = kind
        self.owner = owner
        self.pid = process.pid
        self.stdout = process.stdout
        self._finished = False
        self._lock = threading.Lock()

    def poll(self) -> int | None:
        return self.process.poll()

    def terminate(self) -> None:
        self.owner.signal_owned(self.process, signal.SIGTERM)

    def kill(self) -> None:
        self.owner.signal_owned(self.process, signal.SIGKILL)

    def wait(self, timeout: float | None = None) -> int:
        result = self.process.wait(timeout=timeout)
        self.record_finished(result)
        return result

    def record_finished(self, returncode: int) -> None:
        with self._lock:
            if self._finished:
                return
            self.owner.record("finished", self.kind, self.pid,
                              status="exited", returncode=returncode)
            self._finished = True


class AuditedProcesses:
    """启动前双账本落盘；审计失败或时段届满即回收自有子进程。"""

    def __init__(self, scope: AcceptanceScope, clock: Callable[[], float],
                 process_factory: Callable[..., Any] = subprocess.Popen) -> None:
        self.scope = scope
        self.clock = clock
        self.process_factory = process_factory
        self._audit_lock = threading.RLock()
        self._process_lock = self._audit_lock
        self._children: list[ManagedProcess] = []
        self._stop = threading.Event()
        self._fatal = False
        self._watcher = threading.Thread(target=self._deadline_loop, daemon=True)
        self._watcher.start()
        atexit.register(self.close)

    def record(self, event: str, kind: str, pid: int | None,
               **fields: Any) -> None:
        with self._audit_lock:
            fds: list[int] = []
            try:
                # 两个日志都能安全打开且预写成功，才允许真正执行。
                fds = [_private_fd(self.scope.audit_path, append=True)]
                fds.append(_private_fd(self.scope.pid_audit_path, append=True))
                item = {"event": event, "kind": kind, "pid": pid, **fields}
                for index, fd in enumerate(fds):
                    record = item if index == 0 else {**item, "wrapper_pid": os.getpid(),
                                                     "child_pid": pid}
                    payload = (json.dumps(record, separators=(",", ":")) + "\n").encode()
                    if os.write(fd, payload) != len(payload):
                        raise _fail("acceptance_audit_failed")
                    os.fsync(fd)
            except (OSError, CliCommandError):
                self._fatal = True
                self._stop.set()
                self._stop_owned(record_end=False)
                raise _fail("acceptance_private_file_invalid") from None
            finally:
                for fd in fds:
                    os.close(fd)

    def reject(self, kind: str, code: str) -> None:
        self.record("scope_rejected", kind, None, status="rejected", code=code)

    def _spawn(self, command: tuple[str, ...], kind: str) -> ManagedProcess:
        with self._process_lock:
            if self._fatal or self._stop.is_set():
                raise _fail("acceptance_window_expired")
            if not self.scope.not_before <= self.clock() < self.scope.until:
                raise _fail("acceptance_window_expired")
            self.record("started", kind, None, status="reserved")
            if not self.scope.not_before <= self.clock() < self.scope.until:
                raise _fail("acceptance_window_expired")
            environment = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME", "TMPDIR")
                           if key in os.environ}
            environment.update(PATH="/usr/bin:/bin", TZ="Asia/Taipei",
                               WECHAT_CLI_WCDB_LIB=str(self.scope.real_wcdb))
            try:
                child = self.process_factory(
                    ("/usr/bin/sandbox-exec", "-f", str(self.scope.sandbox_profile), *command),
                    env=environment, cwd="/", stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, bufsize=1, start_new_session=True,
                )
                managed = ManagedProcess(child, kind, self)
                self._children.append(managed)
                self.record("started", kind, managed.pid, status="running")
                return managed
            except OSError:
                raise _fail("acceptance_cli_start_failed") from None

    def command(self, command: tuple[str, ...], kind: str) -> Any:
        managed = self._spawn(command, kind)
        try:
            timeout = min(30.0, max(0.001, self.scope.until - self.clock()))
            try:
                stdout, _ = managed.process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                managed.kill()
                managed.process.communicate(timeout=1)
                managed.wait(timeout=1)
                raise _fail("acceptance_cli_timeout") from None
            managed.record_finished(managed.process.returncode)
            return subprocess.CompletedProcess(command, managed.process.returncode, stdout, "")
        except (OSError, subprocess.TimeoutExpired):
            self.close()
            raise _fail("acceptance_cli_failed") from None

    def follow(self, command: tuple[str, ...], kind: str) -> ManagedProcess:
        return self._spawn(command, kind)

    def signal_owned(self, process: Any, requested: int) -> None:
        if process.poll() is not None:
            return
        if self.process_factory is subprocess.Popen:
            try:
                os.killpg(process.pid, requested)
            except ProcessLookupError:
                pass
        elif requested == signal.SIGKILL:
            process.kill()
        else:
            process.terminate()

    def _stop_owned(self, *, record_end: bool) -> None:
        with self._process_lock:
            children = tuple(self._children)
        for child in children:
            self.signal_owned(child.process, signal.SIGTERM)
        for child in children:
            try:
                result = child.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.signal_owned(child.process, signal.SIGKILL)
                result = child.process.wait(timeout=1)
            if record_end and not self._fatal:
                child.record_finished(result)

    def _deadline_loop(self) -> None:
        while not self._stop.wait(0.1):
            if self.clock() >= self.scope.until:
                self.close()
                return

    def close(self) -> None:
        self._stop.set()
        self._stop_owned(record_end=not self._fatal)


def build_scoped_cli(scope: AcceptanceScope, *, runner: Any = None,
                     follow_runner: Any = None,
                     process_factory: Callable[..., Any] = subprocess.Popen,
                     clock: Callable[[], float] = time.time) -> ScopedCli:
    """公共进程接缝可注入合成 runner；省略时仅调用受审计 sandbox CLI。"""

    guard = ScopeGuard(scope, clock)
    real = None if runner is not None else AuditedProcesses(scope, clock, process_factory)

    def command(command: tuple[str, ...]) -> Any:
        try:
            kind = guard.command_kind(command)
        except CliCommandError as error:
            if real is not None:
                real.reject("version" if command[1:] == ("--version",) else "tail", error.code)
            raise
        return runner(command) if runner is not None else real.command(command, kind)

    def follow(command: tuple[str, ...]) -> Any:
        try:
            kind = guard.command_kind(command, follow=True)
        except CliCommandError as error:
            if real is not None:
                real.reject("sessions_follow", error.code)
            raise
        if follow_runner is not None:
            return follow_runner(command)
        if real is None:
            raise _fail("acceptance_follow_not_configured")
        return real.follow(command, kind)

    actual = LocalWechatCli(executable=str(scope.real_cli), runner=command, follow_runner=follow)
    return ScopedCli(actual, guard, real.close if real is not None else lambda: None,
                     real.reject if real is not None else lambda kind, code: None,
                     (lambda: real.record("accepted", "tail", None, status="validated"))
                     if real is not None else lambda: None)


def main() -> int:
    """仅允许两个真实产品模块；服务模块只替换已约定 CLI 构造接缝。"""

    if len(sys.argv) < 3 or sys.argv[1] != "-m":
        return 2
    module = sys.argv[2]
    if module not in {"notalone.startup_diagnostics", "notalone.server.command"}:
        return 2
    os.environ["NOTALONE_DISABLE_DOTENV"] = "1"
    owned: list[ScopedCli] = []
    try:
        if module == "notalone.server.command":
            scope = load_scope()
            from notalone.front_sync import factory

            def construct(*, executable: str) -> ScopedCli:
                if executable != str(scope.real_cli):
                    raise _fail()
                cli = build_scoped_cli(scope)
                owned.append(cli)
                return cli

            factory.LocalWechatCli = construct
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name="__main__")
        return 0
    except CliCommandError as error:
        print(error.code, file=sys.stderr)
        return 2
    finally:
        for cli in owned:
            cli.close()


if __name__ == "__main__":
    raise SystemExit(main())
