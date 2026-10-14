"""macOS 前台定位探针的只读适配层。

探针是 ``native/macos/`` 工程的本地二进制，负责判断微信是否在前台并
给出顶部 display name 与左侧选中会话行的最小元数据。本适配器只解析
``--session --json`` 的机器可读输出；任何无法解析或无法运行的情况都
失败关闭，不猜测前台状态。
"""

from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from notalone.conversation.matcher import FrontSessionEvidence, normalize_display_text


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
class FrontSessionQuality:
    """已声明最小区域与布局校验的两处OCR质量；不等于绑定已确认。"""

    capture_version: str
    display_name_confidence: float
    selected_row_name_confidence: float

    def __post_init__(self) -> None:
        if self.capture_version not in ("minimal-region-v1", "automatic-window-v1") or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 1
            for value in (
                self.display_name_confidence, self.selected_row_name_confidence,
            )
        ):
            raise ValueError("前台定位质量无效。")

    @property
    def meets_minimum_confidence(self) -> bool:
        return min(
            self.display_name_confidence, self.selected_row_name_confidence,
        ) >= 0.90


@dataclass(frozen=True, slots=True)
class FrontSessionProbeObservation:
    """一次前台定位结果：前台状态与可选的匹配证据。"""

    wechat_in_front: bool
    evidence: FrontSessionEvidence | None
    selected_row_name: str | None = None
    quality: FrontSessionQuality | None = None

    @property
    def qualified_evidence(self) -> FrontSessionEvidence | None:
        """只有已校验布局、两处高质量同名才可交给身份匹配。"""

        if (
            not self.wechat_in_front
            or self.evidence is None
            or self.quality is None
            or not self.quality.meets_minimum_confidence
        ):
            return None
        name = normalize_display_text(self.evidence.display_name)
        if not name or name != normalize_display_text(self.selected_row_name):
            return None
        return self.evidence


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
        "_default_runner",
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
        self._default_runner = runner is None
        # 权限失败不是普通的瞬时探针错误。macOS 可能在子进程每次
        # 调用 ScreenCaptureKit 时重新弹窗；本进程内先熔断，避免后台
        # 心跳把同一个授权请求重复触发。
        self._permission_blocked = False

    def reset_permission_gate(self) -> None:
        """在用户明确完成授权后允许再次尝试一次探针。"""

        self._permission_blocked = False

    def observe(self) -> FrontSessionProbeObservation:
        """读取一次前台定位结果；探针不可用时抛出稳定错误。"""

        return self._observe((self._executable, "--session", "--json"), self._runner)

    def observe_fresh(self, *, timeout_seconds: float) -> FrontSessionProbeObservation:
        """新宿主只允许最小采集协议；旧二进制须在采集前拒绝新参数。"""

        if (
            isinstance(timeout_seconds, bool)
            or not math.isfinite(timeout_seconds)
            or not 0 < timeout_seconds <= 1.0
        ):
            raise ValueError("新观察的探针预算须在一秒以内。")
        runner = (
            (lambda command: self._run_command(command, timeout_seconds=timeout_seconds))
            if self._default_runner
            else self._runner
        )
        return self._observe(
            (self._executable, "--session", "--json", "--minimal-region"), runner,
        )

    def _observe(
        self, command: tuple[str, ...], runner: CommandRunner,
    ) -> FrontSessionProbeObservation:
        if self._permission_blocked:
            raise ProbeAdapterError(
                "screen_capture_permission_missing",
                "未授予屏幕录制权限；等待用户授权后再重新检测。",
            )

        try:
            result = runner(command)
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
            selected_row_name=_optional_text(envelope.get("selected_row_name")),
            quality=_quality(envelope),
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

    def _run_command(
        self, command: tuple[str, ...], *, timeout_seconds: float | None = None,
    ) -> CommandResult:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=self._timeout_seconds if timeout_seconds is None else timeout_seconds,
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


def _quality(envelope: dict[str, Any]) -> FrontSessionQuality | None:
    """旧协议、未校验布局或缺必要证据不获得质量资格。"""

    if envelope.get("capture_version") not in ("minimal-region-v1", "automatic-window-v1"):
        return None
    quality = envelope.get("quality")
    if quality is None:
        return None
    fields = {
        "layout_verified", "display_name_confidence",
        "selected_row_name_confidence",
    }
    if not isinstance(quality, dict) or set(quality) - fields:
        raise ProbeAdapterError("probe_output_invalid", "前台定位质量无效。")
    if not fields.issubset(quality):
        return None
    if type(quality["layout_verified"]) is not bool:
        raise ProbeAdapterError("probe_output_invalid", "前台定位质量无效。")
    try:
        result = FrontSessionQuality(
            capture_version=envelope["capture_version"],
            display_name_confidence=quality["display_name_confidence"],
            selected_row_name_confidence=quality["selected_row_name_confidence"],
        )
    except ValueError as error:
        raise ProbeAdapterError(
            "probe_output_invalid", "前台定位质量无效。",
        ) from error
    return result if quality["layout_verified"] else None
