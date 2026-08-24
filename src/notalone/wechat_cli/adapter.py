"""用户自行安装的本地微信 CLI 只读适配器。"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from notalone.wechat_cli.errors import CliCommandError, CliOutputError
from notalone.wechat_cli.models import (
    ChatCandidate,
    ChatResolution,
    CliMessageEvent,
    MessageIdentifier,
    TailResult,
)


class CommandResult(Protocol):
    """subprocess 结果的最小测试 seam。"""

    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[tuple[str, ...]], CommandResult]


@dataclass(frozen=True, slots=True)
class _SubprocessResult:
    returncode: int
    stdout: str
    stderr: str


class LocalWechatCli:
    """把 CLI 的进程和 JSONL 细节隐藏在一个小的只读接口后。"""

    def __init__(
        self,
        *,
        executable: str = "wechat-cli",
        runner: CommandRunner | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not executable.strip():
            raise ValueError("CLI 可执行文件不能为空。")
        if timeout_seconds <= 0:
            raise ValueError("CLI 超时时间必须大于零。")
        self._executable = executable
        self._timeout_seconds = timeout_seconds
        self._runner = runner or self._run_command

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
            command.extend(["--type-filter", _require_text(type_filter, "type_filter")])
        command.append("--strict-read-only")
        envelope = self._run_json(tuple(command))
        data = _object_field(envelope, "data")
        raw_candidates = data.get("candidates")
        if not isinstance(raw_candidates, list):
            raise CliOutputError("cli_output_invalid", "CLI 候选列表无效。")
        return ChatResolution(
            query=query,
            candidates=tuple(_parse_candidate(item) for item in raw_candidates),
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
            command.extend(["--type-filter", _require_text(type_filter, "type_filter")])
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
        limit: int | None = None,
    ) -> TailResult:
        """读取一次会话文字增量；不传 cursor 表示首次读取。

        没有新消息时返回空结果而不是错误；调用方保持既有水位。
        """

        talker = _require_text(talker, "talker")
        command = [self._executable, "tail", talker]
        if cursor is not None:
            command.extend(["--cursor", _require_text(cursor, "cursor")])
        if limit is not None:
            if limit < 1:
                raise ValueError("limit 必须大于零。")
            command.extend(["--limit", str(limit)])
        command.extend(["--jsonl", "--strict-read-only"])
        result = self._invoke(tuple(command))
        return _parse_tail_output(result.stdout, expected_talker=talker)

    def version(self) -> str:
        """读取 CLI 版本标识，用于观察来源元数据。"""

        envelope = self._run_json((self._executable, "--version"))
        data = _object_field(envelope, "data")
        return _require_text(data.get("version"), "data.version")

    def _run_json(self, command: tuple[str, ...]) -> dict[str, Any]:
        result = self._invoke(command)
        try:
            value = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise CliOutputError("cli_output_invalid", "微信 CLI 返回了无效 JSON。") from error
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise CliOutputError("cli_output_invalid", "微信 CLI 返回了失败结果。")
        return value

    def _invoke(self, command: tuple[str, ...]) -> CommandResult:
        try:
            result = self._runner(command)
        except FileNotFoundError as error:
            raise CliCommandError("cli_not_found", "微信 CLI 不可用。") from error
        except subprocess.TimeoutExpired as error:
            raise CliCommandError("cli_timeout", "微信 CLI 命令超时。") from error
        if result.returncode != 0:
            raise CliCommandError("cli_command_failed", "微信 CLI 命令执行失败。")
        return result

    def _run_command(self, command: tuple[str, ...]) -> CommandResult:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=self._timeout_seconds,
        )
        return _SubprocessResult(
            returncode=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )


def _parse_tail_output(stdout: str, *, expected_talker: str) -> TailResult:
    events: list[CliMessageEvent] = []
    cursor: str | None = None
    last_local_id: int | None = None
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        # 轮询没有新消息是正常结果；调用方保持既有水位。
        return TailResult(events=(), cursor=None, last_local_id=None)
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise CliOutputError("cli_output_invalid", "微信 CLI 返回了无效事件。") from error
        if not isinstance(event, dict) or event.get("type") != "message":
            raise CliOutputError("cli_output_invalid", "微信 CLI 返回了不支持的事件。")
        cursor = _require_text(event.get("cursor"), "cursor")
        message = _object_field(event, "message")
        message_id = _object_field(message, "id")
        local_id = message_id.get("local_id")
        if isinstance(local_id, bool) or not isinstance(local_id, int) or local_id <= 0:
            raise CliOutputError("cli_output_invalid", "微信 CLI 消息 ID 无效。")
        message_talker = _require_text(message_id.get("talker"), "message.id.talker")
        if message_talker != expected_talker:
            raise CliOutputError("cli_output_invalid", "微信 CLI 返回了其他会话的消息。")
        if last_local_id is None or local_id > last_local_id:
            last_local_id = local_id
        kind = _require_text(message.get("kind"), "message.kind")
        if kind != "text":
            continue
        text = _require_text(message.get("text"), "message.text")
        is_from_me = message.get("is_from_me")
        if not isinstance(is_from_me, bool):
            raise CliOutputError("cli_output_invalid", "微信 CLI 说话人标记无效。")
        events.append(
            CliMessageEvent(
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
            )
        )
    return TailResult(
        events=tuple(events),
        cursor=cursor,
        last_local_id=last_local_id,
    )


def _parse_candidate(value: object) -> ChatCandidate:
    if not isinstance(value, dict):
        raise CliOutputError("cli_output_invalid", "微信 CLI 会话候选无效。")
    return ChatCandidate(
        username=_require_text(value.get("username"), "candidate.username"),
        display_name=_require_text(value.get("display_name"), "candidate.display_name"),
        match=_optional_text(value.get("match")),
        chat_type=_require_text(value.get("chat_type"), "candidate.chat_type"),
        last_timestamp=_optional_int(value.get("last_timestamp")),
        sort_timestamp=_optional_int(value.get("sort_timestamp")),
        source=_optional_text(value.get("source")),
        summary=_optional_text(value.get("summary")),
        last_sender_display_name=_optional_text(value.get("last_sender_display_name")),
    )


def _object_field(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get(field), dict):
        raise CliOutputError("cli_output_invalid", f"微信 CLI 字段 {field} 无效。")
    return value[field]


def _require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CliOutputError("cli_output_invalid", f"微信 CLI 字段 {field} 无效。")
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
