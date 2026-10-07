"""用户自行安装的本地微信 CLI 只读适配器。"""

from __future__ import annotations

import json
import queue
import re
import subprocess
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol

from notalone.source_processing.models import ProcessingRecord, execution
from notalone.wechat_cli.errors import (
    CliAdapterError,
    CliCommandError,
    CliOutputError,
)
from notalone.wechat_cli.models import (
    ChatCandidate,
    ChatResolution,
    CliMessageEvent,
    CliSessionEvent,
    MessageIdentifier,
    TailFollowItem,
    TailResult,
)


class CommandResult(Protocol):
    """subprocess 结果的最小测试 seam。"""

    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[tuple[str, ...]], CommandResult]
FollowProcessRunner = Callable[[tuple[str, ...]], object]


@dataclass(frozen=True, slots=True)
class _SubprocessResult:
    returncode: int
    stdout: str
    stderr: str


class TailFollowStream:
    """可关闭的 ``tail --follow`` 只读流。"""

    def __init__(self, process: object, *, expected_talker: str) -> None:
        self._process = process
        self._expected_talker = expected_talker
        self._queue: queue.Queue[TailFollowItem | BaseException | None] = (
            queue.Queue()
        )
        self._closed = False
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    @property
    def process_id(self) -> int | None:
        """返回 follow 子进程 PID；不可用时返回 None。"""

        value = getattr(self._process, "pid", None)
        return value if isinstance(value, int) and value > 0 else None

    def read(self, timeout: float | None = None) -> TailFollowItem | None:
        try:
            item = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        terminate = getattr(self._process, "terminate", None)
        if callable(terminate):
            terminate()
        wait = getattr(self._process, "wait", None)
        if callable(wait):
            try:
                wait(timeout=1.0)
            except (TimeoutError, subprocess.TimeoutExpired):
                kill = getattr(self._process, "kill", None)
                if callable(kill):
                    kill()

    def _read_loop(self) -> None:
        try:
            reader = getattr(self._process, "stdout", None)
            if reader is None:
                reader = self._process
            line_number = 0
            while not self.closed:
                line = reader.readline()
                if not line:
                    break
                line_number += 1
                started_at = datetime.now(timezone.utc)
                try:
                    item = _parse_follow_line(
                        line,
                        expected_talker=self._expected_talker,
                        input_position=line_number,
                    )
                except CliOutputError as error:
                    error.failure_record = _parse_failure_record(
                        started_at, f"cli_event:{line_number}", error.code
                    )
                    raise
                if item is not None:
                    self._queue.put(item)
            returncode = _poll_process(self._process)
            if returncode not in (None, 0) and not self.closed:
                self._queue.put(
                    CliCommandError(
                        "cli_follow_failed", "微信 CLI 流进程异常退出。"
                    )
                )
        except CliAdapterError as error:
            if not self.closed:
                self._queue.put(error)
        finally:
            with self._lock:
                self._closed = True
            self._queue.put(None)


class SessionEventStream:
    """可关闭的全局 ``tail --mode sessions --follow`` 只读流。"""

    def __init__(self, process: object) -> None:
        self._process = process
        self._queue: queue.Queue[CliSessionEvent | BaseException | None] = (
            queue.Queue()
        )
        self._closed = False
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    @property
    def process_id(self) -> int | None:
        """返回全局流子进程 PID；不可用时返回 None。"""

        value = getattr(self._process, "pid", None)
        return value if isinstance(value, int) and value > 0 else None

    def read(self, timeout: float | None = None) -> CliSessionEvent | None:
        try:
            item = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        if isinstance(item, BaseException):
            raise item
        return item

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        terminate = getattr(self._process, "terminate", None)
        if callable(terminate):
            terminate()
        wait = getattr(self._process, "wait", None)
        if callable(wait):
            try:
                wait(timeout=1.0)
            except (TimeoutError, subprocess.TimeoutExpired):
                kill = getattr(self._process, "kill", None)
                if callable(kill):
                    kill()

    def _read_loop(self) -> None:
        try:
            reader = getattr(self._process, "stdout", None)
            if reader is None:
                reader = self._process
            while not self.closed:
                line = reader.readline()
                if not line:
                    break
                event = _parse_session_line(line)
                if event is not None:
                    self._queue.put(event)
            returncode = _poll_process(self._process)
            if returncode not in (None, 0) and not self.closed:
                self._queue.put(
                    CliCommandError(
                        "cli_follow_failed", "微信 CLI 流进程异常退出。"
                    )
                )
        except CliAdapterError as error:
            if not self.closed:
                self._queue.put(error)
        finally:
            with self._lock:
                self._closed = True
            self._queue.put(None)


class LocalWechatCli:
    """把 CLI 的进程和 JSONL 细节隐藏在一个小的只读接口后。"""

    def __init__(
        self,
        *,
        executable: str = "wechat-cli",
        runner: CommandRunner | None = None,
        follow_runner: FollowProcessRunner | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not executable.strip():
            raise ValueError("CLI 可执行文件不能为空。")
        if timeout_seconds <= 0:
            raise ValueError("CLI 超时时间必须大于零。")
        self._executable = executable
        self._timeout_seconds = timeout_seconds
        self._runner = runner or self._run_command
        if follow_runner is not None:
            self._follow_runner = follow_runner
        elif runner is not None:
            # 旧的命令 runner 只模拟一次性命令；适配器明确降级，避免
            # 测试或其他调用方意外启动真实长进程。
            self._follow_runner = self._unsupported_follow_runner
        else:
            self._follow_runner = self._run_follow_process
        self._process_lock = threading.Lock()
        self._active_processes: set[object] = set()

    def resolve_chat(
        self,
        query: str,
        *,
        type_filter: str | None = None,
    ) -> ChatResolution:
        """解析 display name/备注为外部会话候选。"""

        query = _require_text(query, "query")
        command = [self._executable, "resolve-chat", query]
        if type_filter is not None:
            command.extend(
                ["--type-filter", _require_text(type_filter, "type_filter")]
            )
        command.append("--strict-read-only")
        envelope = self._run_json(tuple(command))
        data = _object_field(envelope, "data")
        raw_candidates = data.get("candidates")
        if not isinstance(raw_candidates, list):
            raise CliOutputError("cli_output_invalid", "CLI 候选列表无效。")
        return ChatResolution(
            query=query,
            candidates=tuple(
                _parse_candidate(item) for item in raw_candidates
            ),
        )

    def sessions(
        self,
        *,
        keyword: str | None = None,
        type_filter: str | None = None,
        limit: int | None = None,
    ) -> tuple[ChatCandidate, ...]:
        """读取 CLI 会话元数据，不读取消息正文。"""

        command = [self._executable, "sessions"]
        if keyword is not None:
            command.extend(["--keyword", _require_text(keyword, "keyword")])
        if type_filter is not None:
            command.extend(
                ["--type-filter", _require_text(type_filter, "type_filter")]
            )
        if limit is not None:
            if limit < 1:
                raise ValueError("limit 必须大于零。")
            command.extend(["--limit", str(limit)])
        command.append("--strict-read-only")
        envelope = self._run_json(tuple(command))
        data = _object_field(envelope, "data")
        raw_sessions = data.get("sessions")
        if not isinstance(raw_sessions, list):
            raise CliOutputError("cli_output_invalid", "CLI 会话列表无效。")
        return tuple(_parse_candidate(item) for item in raw_sessions)

    def tail(
        self,
        talker: str,
        *,
        cursor: str | None = None,
        since_time: str | None = None,
        limit: int | None = None,
    ) -> TailResult:
        """读取一次会话文字增量；不传 cursor 表示首次读取。

        没有新消息时返回空结果而不是错误；调用方保持既有水位。
        """

        talker = _require_text(talker, "talker")
        if cursor is not None and since_time is not None:
            raise ValueError("cursor 与 since_time 不能同时提供。")
        command = [self._executable, "tail", talker]
        if cursor is not None:
            command.extend(["--cursor", _require_text(cursor, "cursor")])
        if since_time is not None:
            command.extend(
                ["--since-time", _require_text(since_time, "since_time")]
            )
        if limit is not None:
            if limit < 1:
                raise ValueError("limit 必须大于零。")
            command.extend(["--limit", str(limit)])
        command.extend(["--jsonl", "--strict-read-only"])
        result = self._invoke(tuple(command))
        return _parse_tail_output(result.stdout, expected_talker=talker)

    def tail_follow(
        self,
        talker: str,
        *,
        cursor: str | None = None,
    ) -> TailFollowStream:
        """启动单一会话的 ``tail --follow`` 流；调用方负责关闭。"""

        talker = _require_text(talker, "talker")
        command = [self._executable, "tail", talker]
        if cursor is not None:
            command.extend(["--cursor", _require_text(cursor, "cursor")])
        command.extend(["--follow", "--jsonl", "--strict-read-only"])
        try:
            process = self._follow_runner(tuple(command))
        except FileNotFoundError as error:
            raise CliCommandError(
                "cli_not_found", "微信 CLI 不可用。"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise CliCommandError(
                "cli_timeout", "微信 CLI 命令超时。"
            ) from error
        return TailFollowStream(process, expected_talker=talker)

    def session_events_follow(
        self,
        *,
        cursor: str | None = None,
        scan_limit: int = 5000,
        poll_interval: str = "3s",
    ) -> SessionEventStream:
        """启动唯一的全局会话事件流；调用方负责关闭。"""

        if cursor is not None:
            cursor = _require_text(cursor, "cursor")
        if isinstance(scan_limit, bool) or not isinstance(scan_limit, int):
            raise TypeError("scan_limit 必须是整数。")
        if scan_limit < 1 or scan_limit > 5000:
            raise ValueError("scan_limit 必须在 1 到 5000 之间。")
        poll_interval = _require_text(poll_interval, "poll_interval")
        command = [
            self._executable,
            "tail",
        ]
        if cursor is not None:
            command.extend(["--cursor", cursor])
        command.extend(
            [
                "--mode",
                "sessions",
                "--scan-limit",
                str(scan_limit),
                "--poll-interval",
                poll_interval,
                "--follow",
                "--jsonl",
                "--strict-read-only",
            ]
        )
        try:
            process = self._follow_runner(tuple(command))
        except FileNotFoundError as error:
            raise CliCommandError(
                "cli_not_found", "微信 CLI 不可用。"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise CliCommandError(
                "cli_timeout", "微信 CLI 命令超时。"
            ) from error
        return SessionEventStream(process)

    def version(self) -> str:
        """读取 CLI 版本标识，用于观察来源元数据。"""

        envelope = self._run_json((self._executable, "--version"))
        data = _object_field(envelope, "data")
        return _require_text(data.get("version"), "data.version")

    def close(self) -> None:
        """终止正在执行的一次性命令；已完成命令不受影响。"""

        with self._process_lock:
            processes = tuple(self._active_processes)
        for process in processes:
            poll = getattr(process, "poll", None)
            if not callable(poll) or poll() is not None:
                continue
            terminate = getattr(process, "terminate", None)
            if callable(terminate):
                terminate()
        for process in processes:
            wait = getattr(process, "wait", None)
            if not callable(wait):
                continue
            try:
                wait(timeout=1.0)
            except (TimeoutError, subprocess.TimeoutExpired):
                kill = getattr(process, "kill", None)
                if callable(kill):
                    kill()
                try:
                    wait(timeout=1.0)
                except (TimeoutError, subprocess.TimeoutExpired):
                    pass

    def _run_json(self, command: tuple[str, ...]) -> dict[str, Any]:
        result = self._invoke(command)
        try:
            value = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise CliOutputError(
                "cli_output_invalid", "微信 CLI 返回了无效 JSON。"
            ) from error
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise CliOutputError(
                "cli_output_invalid", "微信 CLI 返回了失败结果。"
            )
        return value

    def _invoke(self, command: tuple[str, ...]) -> CommandResult:
        try:
            result = self._runner(command)
        except FileNotFoundError as error:
            raise CliCommandError(
                "cli_not_found", "微信 CLI 不可用。"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise CliCommandError(
                "cli_timeout", "微信 CLI 命令超时。"
            ) from error
        if result.returncode != 0:
            raise _command_failure(result)
        return result

    def _run_command(self, command: tuple[str, ...]) -> CommandResult:
        with self._process_lock:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self._active_processes.add(process)
        try:
            try:
                stdout, stderr = process.communicate(
                    timeout=self._timeout_seconds
                )
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
                raise
        finally:
            with self._process_lock:
                self._active_processes.discard(process)
        return _SubprocessResult(
            returncode=process.returncode,
            stdout=stdout,
            stderr=stderr,
        )

    def _run_follow_process(self, command: tuple[str, ...]) -> object:
        return subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

    @staticmethod
    def _unsupported_follow_runner(command: tuple[str, ...]) -> object:
        del command
        raise CliCommandError(
            "cli_follow_unsupported",
            "当前 CLI 适配器不提供 follow 流能力。",
        )


def _command_failure(result: CommandResult) -> CliCommandError:
    """把 CLI 的结构化失败转换成不泄漏正文的稳定错误。"""

    code, message = _structured_error(result.stdout)
    if code == "invalid_argument":
        return CliCommandError("cli_invalid_argument", "微信 CLI 参数无效。")
    if code == "tool_error" and _requires_key_refresh(message):
        return CliCommandError(
            "cli_key_refresh_required",
            "微信 CLI 本机读取密钥需要刷新。",
        )
    if code == "tool_error" and _message_table_missing(message):
        return CliCommandError(
            "cli_message_table_missing",
            "CLI 未找到该会话的本地消息表，无法确认消息覆盖。",
        )
    return CliCommandError("cli_command_failed", "微信 CLI 命令执行失败。")


def _structured_error(stdout: str) -> tuple[str | None, str | None]:
    """读取失败 envelope 的类型字段，不把原始错误文本带出适配器。"""

    try:
        value = json.loads(stdout)
    except (TypeError, json.JSONDecodeError):
        return None, None
    if not isinstance(value, dict) or value.get("ok") is not False:
        return None, None
    error = value.get("error")
    if not isinstance(error, dict):
        return None, None
    code = error.get("code")
    message = error.get("message")
    return (
        code if isinstance(code, str) else None,
        message if isinstance(message, str) else None,
    )


def _requires_key_refresh(message: str | None) -> bool:
    """识别 CLI 明确报告的只读密钥缺失，不匹配一般工具错误。"""

    if message is None:
        return False
    normalized = message.casefold()
    return (
        "automatic key refresh is disabled" in normalized
        and "enc_key" in normalized
    )


def _message_table_missing(message: str | None) -> bool:
    """只识别已验证 CLI 模板；表名留在适配器内，不当作空结果。"""

    return (
        message is not None
        and re.fullmatch(
            r"table \S+ not found in (?:\d+|opened) message shards", message
        )
        is not None
    )


def _parse_tail_output(stdout: str, *, expected_talker: str) -> TailResult:
    events: list[CliMessageEvent] = []
    last_local_id: int | None = None
    last_cursor: str | None = None
    event_count = 0
    non_text_count = 0
    filtered_records: list[ProcessingRecord] = []
    lines = stdout.splitlines(keepends=True)
    if not any(line.strip() for line in lines):
        # 轮询没有新消息是正常结果；调用方保持既有水位。
        return TailResult(
            events=(),
            cursor=None,
            last_local_id=None,
            freshness_confirmed=False,
        )
    for position, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        started_at = datetime.now(timezone.utc)
        try:
            item = _parse_follow_line(
                line, expected_talker=expected_talker, input_position=position
            )
        except CliOutputError as error:
            error.failure_record = _parse_failure_record(
                started_at, f"cli_event:{position}", error.code
            )
            raise
        if item is None:
            unsupported_error = CliOutputError(
                "cli_output_invalid", "微信 CLI 返回了不支持的事件。"
            )
            unsupported_error.failure_record = _parse_failure_record(
                started_at, f"cli_event:{position}", unsupported_error.code
            )
            raise unsupported_error
        event_count += 1
        local_id = item.local_id
        # 文字与非文字事件都参与水位推进；cursor 必须和选出的最大
        # local_id 来自同一条事件，不能在 JSONL 乱序时取最后一行。
        if last_local_id is None or local_id > last_local_id:
            last_local_id = local_id
            last_cursor = item.cursor
        if item.event is None:
            # 非文字事件只前移水位，不产生可写消息。
            non_text_count += 1
            if item.processing_record is not None:
                filtered_records.append(item.processing_record)
            continue
        events.append(item.event)
    return TailResult(
        events=tuple(events),
        cursor=last_cursor,
        last_local_id=last_local_id,
        event_count=event_count,
        non_text_count=non_text_count,
        freshness_confirmed=True,
        filtered_records=tuple(filtered_records),
    )


def _parse_follow_line(
    line: str,
    *,
    expected_talker: str,
    input_position: int | None = None,
) -> TailFollowItem | None:
    started_at = datetime.now(timezone.utc)
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise CliOutputError(
            "cli_output_invalid", "微信 CLI 返回了无效事件。"
        ) from None
    if not isinstance(value, dict) or value.get("type") != "message":
        return None
    cursor = _require_text(value.get("cursor"), "cursor")
    message = _object_field(value, "message")
    message_id = _object_field(message, "id")
    local_id = message_id.get("local_id")
    if (
        isinstance(local_id, bool)
        or not isinstance(local_id, int)
        or local_id <= 0
    ):
        raise CliOutputError("cli_output_invalid", "微信 CLI 消息 ID 无效。")
    message_talker = _require_text(
        message_id.get("talker"), "message.id.talker"
    )
    if message_talker != expected_talker:
        raise CliOutputError(
            "cli_output_invalid", "微信 CLI 返回了其他会话的消息。"
        )
    kind = _require_text(message.get("kind"), "message.kind")
    if kind != "text":
        # 不保存媒体原行或未知载荷，只保留定位和实际筛选结果。
        record = ProcessingRecord.capture(
            f"cli:{local_id}",
            {
                "capture_layer": "metadata_only",
                "input_position": input_position,
                "record_text": None,
                "parsed": {
                    "type": "message",
                    "cursor": cursor,
                    "message": {
                        "id": {"local_id": local_id, "talker": message_talker},
                        "kind": kind,
                    },
                },
                "parse": execution(started_at, __file__, status="filtered"),
                "outcome": "non_text_filtered",
                "filter_rule": "text_only",
            },
        )
        return TailFollowItem(
            cursor=cursor,
            local_id=local_id,
            event=None,
            processing_record=record,
        )
    text = _require_text(message.get("text"), "message.text")
    is_from_me = message.get("is_from_me")
    if not isinstance(is_from_me, bool):
        raise CliOutputError("cli_output_invalid", "微信 CLI 说话人标记无效。")
    event = CliMessageEvent(
        message_id=MessageIdentifier(
            local_id=local_id,
            talker=message_talker,
            server_id_str=_optional_text(message_id.get("server_id_str")),
        ),
        text=text,
        kind=kind,
        sender=_optional_text(message.get("sender")),
        sender_wxid=_optional_text(message.get("sender_wxid")),
        is_from_me=is_from_me,
        create_time=_optional_int(message.get("create_time")),
        time=_optional_text(message.get("time")),
        time_iso=_optional_text(message.get("time_iso")),
        processing_record=ProcessingRecord.capture(
            f"cli:{local_id}",
            {
                "capture_layer": "cli_event_text",
                "input_position": input_position,
                "record_text": line,
                "parsed": value,
                "parse": execution(started_at, __file__),
            },
        ),
    )
    return TailFollowItem(
        cursor=cursor,
        local_id=local_id,
        event=event,
        processing_record=event.processing_record,
    )


def _parse_failure_record(
    started_at: datetime, locator: str, code: str
) -> ProcessingRecord:
    return ProcessingRecord.capture(
        locator,
        {
            "capture_layer": "metadata_only",
            "record_text": None,
            "parsed": None,
            "capture_status": "withheld_unverified_input",
            "stage": "parse",
            "parse": execution(started_at, __file__, status="failed"),
            "error_code": code,
            "outcome": "input_rejected",
        },
    )


def _parse_session_line(line: str) -> CliSessionEvent | None:
    """解析全局 sessions/unread 事件，不保留会话展示字段。"""

    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise CliOutputError(
            "cli_output_invalid", "微信 CLI 返回了无效事件。"
        ) from error
    if not isinstance(value, dict) or value.get("type") not in {
        "session",
        "unread",
    }:
        return None
    cursor = _require_text(value.get("cursor"), "cursor")
    candidates: list[object] = []
    for field in ("session", "conversation", "data"):
        nested = value.get(field)
        if isinstance(nested, dict):
            candidates.extend(
                nested.get(name)
                for name in (
                    "username",
                    "talker",
                    "conversation_locator",
                    "locator",
                )
            )
    candidates.extend(
        value.get(name)
        for name in ("username", "talker", "conversation_locator")
    )
    locator = next(
        (
            item
            for item in candidates
            if isinstance(item, str) and item.strip()
        ),
        None,
    )
    if locator is None:
        raise CliOutputError(
            "cli_output_invalid", "微信 CLI 会话事件缺少定位标识。"
        )
    return CliSessionEvent(cursor=cursor, conversation_locator=locator)


def _poll_process(process: object) -> int | None:
    poll = getattr(process, "poll", None)
    return poll() if callable(poll) else None


def _parse_candidate(value: object) -> ChatCandidate:
    if not isinstance(value, dict):
        raise CliOutputError("cli_output_invalid", "微信 CLI 会话候选无效。")
    return ChatCandidate(
        username=_require_text(value.get("username"), "candidate.username"),
        display_name=_require_text(
            value.get("display_name"), "candidate.display_name"
        ),
        match=_optional_text(value.get("match")),
        chat_type=_require_text(value.get("chat_type"), "candidate.chat_type"),
        last_timestamp=_optional_int(value.get("last_timestamp")),
        sort_timestamp=_optional_int(value.get("sort_timestamp")),
        source=_optional_text(value.get("source")),
        summary=_optional_text(value.get("summary")),
        last_sender_display_name=_optional_text(
            value.get("last_sender_display_name")
        ),
    )


def _object_field(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get(field), dict):
        raise CliOutputError(
            "cli_output_invalid", f"微信 CLI 字段 {field} 无效。"
        )
    return value[field]


def _require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CliOutputError(
            "cli_output_invalid", f"微信 CLI 字段 {field} 无效。"
        )
    return value


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise CliOutputError("cli_output_invalid", "微信 CLI 文本字段无效。")
    return value


def _optional_int(value: object) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise CliOutputError("cli_output_invalid", "微信 CLI 时间字段无效。")
    return value
