"""macOS 前台定位探针的只读适配层。

探针是 ``native/macos/`` 工程的本地二进制，负责判断微信是否在前台并
给出顶部 display name 与左侧选中会话行的最小元数据。本适配器只解析
``--session --json`` 的机器可读输出；任何无法解析或无法运行的情况都
失败关闭，不猜测前台状态。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from notalone.conversation.matcher import FrontSessionEvidence


class ProbeAdapterError(RuntimeError):
    """不回显探针输出、路径或会话内容的适配器错误。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


class CommandResult(Protocol):
    """subprocess 结果的最小测试 seam。"""

    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[tuple[str, ...]], CommandResult]


@dataclass(frozen=True, slots=True)
class FrontSessionProbeObservation:
    """一次前台定位结果：前台状态与可选的匹配证据。"""

    wechat_in_front: bool
    evidence: FrontSessionEvidence | None


@dataclass(frozen=True, slots=True)
class _SubprocessResult:
    returncode: int
    stdout: str
    stderr: str


class MacosFrontSessionProbe:
    """调用本机探针二进制的单次前台定位；不保存截图或正文。"""

    __slots__ = (
        "_executable",
        "_runner",
        "_timeout_seconds",
        "_permission_blocked",
    )

    def __init__(
        self,
        *,
        executable: str = "notalone-sync-probe",
        runner: CommandRunner | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not isinstance(executable, str) or not executable.strip():
            raise ValueError("探针可执行文件不能为空。")
        if timeout_seconds <= 0:
            raise ValueError("探针超时时间必须大于零。")
        self._executable = executable
        self._timeout_seconds = timeout_seconds
        self._runner = runner or self._run_command
        # 权限失败不是普通的瞬时探针错误。macOS 可能在子进程每次
        # 调用 ScreenCaptureKit 时重新弹窗；本进程内先熔断，避免后台
        # 心跳把同一个授权请求重复触发。
        self._permission_blocked = False

    def reset_permission_gate(self) -> None:
        """在用户明确完成授权后允许再次尝试一次探针。"""

        self._permission_blocked = False

    def observe(self) -> FrontSessionProbeObservation:
        """读取一次前台定位结果；探针不可用时抛出稳定错误。"""

        if self._permission_blocked:
            raise ProbeAdapterError(
                "screen_capture_permission_missing",
                "未授予屏幕录制权限；等待用户授权后再重新检测。",
            )

        command = (self._executable, "--session", "--json")
        try:
            result = self._runner(command)
        except FileNotFoundError as error:
            raise ProbeAdapterError("probe_not_found", "前台定位探针不可用。") from error
        except subprocess.TimeoutExpired as error:
            raise ProbeAdapterError("probe_timeout", "前台定位探针超时。") from error

        if result.returncode != 0:
            code, message = self._failure_from_output(
                result.stdout,
                fallback="probe_failed",
            )
            if code == "screen_capture_permission_missing":
                self._permission_blocked = True
            raise ProbeAdapterError(code, message)
        try:
            envelope = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise ProbeAdapterError(
                "probe_output_invalid", "前台定位探针返回了无效 JSON。"
            ) from error
        if not isinstance(envelope, dict):
            raise ProbeAdapterError(
                "probe_output_invalid", "前台定位探针返回了无效结果。"
            )
        if envelope.get("ok") is not True:
            code, message = self._failure_from_envelope(envelope)
            if code == "screen_capture_permission_missing":
                self._permission_blocked = True
            raise ProbeAdapterError(code, message)
        in_front = envelope.get("wechat_in_front")
        if not isinstance(in_front, bool):
            raise ProbeAdapterError(
                "probe_output_invalid", "前台定位探针缺少前台状态。"
            )
        if not in_front:
            return FrontSessionProbeObservation(wechat_in_front=False, evidence=None)
        return FrontSessionProbeObservation(
            wechat_in_front=True,
            evidence=FrontSessionEvidence(
                display_name=_optional_text(envelope.get("display_name")),
                last_time_text=_optional_text(envelope.get("last_time_text")),
                preview_text=_optional_text(envelope.get("preview_text")),
            ),
        )

    @staticmethod
    def _failure_from_output(
        stdout: str, *, fallback: str
    ) -> tuple[str, str]:
        """探针以失败状态退出时尽量保留其稳定错误码。"""

        try:
            envelope = json.loads(stdout)
        except (TypeError, json.JSONDecodeError):
            return fallback, "前台定位探针执行失败。"
        if not isinstance(envelope, dict):
            return fallback, "前台定位探针执行失败。"
        if envelope.get("ok") is False:
            return MacosFrontSessionProbe._failure_from_envelope(envelope)
        return fallback, "前台定位探针执行失败。"

    @staticmethod
    def _failure_from_envelope(envelope: dict[str, Any]) -> tuple[str, str]:
        code = envelope.get("error")
        if isinstance(code, str) and code.strip() and not code[0].isspace():
            return code, "前台定位探针报告了环境错误。"
        return "probe_failed", "前台定位探针报告了环境错误。"

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


def _optional_text(value: object) -> str | None:
    """字段缺失或显式 null 都按未识别处理；其他类型失败关闭。"""

    if value is None:
        return None
    if not isinstance(value, str):
        raise ProbeAdapterError(
            "probe_output_invalid", "前台定位探针返回了无效的文本字段。"
        )
    return value
