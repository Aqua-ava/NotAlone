"""ECNU与官方Flash最高思考的评测请求契约；生产提取路径不引用此门。"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import Callable, Iterator

import httpx

from .evaluation_http_budget import EvaluationBudgetAbort


_ENDPOINT = "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"
_PAYLOAD_FIELDS = frozenset({
    "model", "temperature", "stream", "thinking", "messages", "tools", "tool_choice",
})
_TOOL_NAMES = frozenset({"MemoryExtractionOutput", "SourceVerificationOutput"})
STRICT_RESPONSE_IDENTITY_POLICY = "first_valid_completion_observation_stop_on_change"
KNOWN_ECNU_RESPONSE_IDENTITY_POLICY = "ecnu_configured_route_known_labels_v1"
KNOWN_ECNU_RESPONSE_LABELS = frozenset({"deepseek-v4-flash", "deepseek-flash"})


class EvaluationProviderProfile(StrEnum):
    """仅两个显式评测配置；不接受任意端点或生产配置覆盖。"""

    ECNU = "ecnu"
    DEEPSEEK_FLASH_MAX = "deepseek-flash-max"

    @property
    def base_url(self) -> str:
        return ("https://api.deepseek.com" if self is self.DEEPSEEK_FLASH_MAX
                else "https://chat.ecnu.edu.cn/open/api/v1")

    @property
    def endpoint(self) -> str:
        return self.base_url + "/chat/completions"

    @property
    def model(self) -> str:
        return "deepseek-flash" if self is self.DEEPSEEK_FLASH_MAX else "ecnu-max"


def validate_evaluation_policy(
    verification_tool_choice: str, response_identity_policy: str = STRICT_RESPONSE_IDENTITY_POLICY,
) -> None:
    """只认可显式评测策略；未知策略在登记与凭据之前拒绝。"""
    if (type(verification_tool_choice) is not str
            or verification_tool_choice not in {"forced", "omitted"}
            or type(response_identity_policy) is not str
            or response_identity_policy not in {
                STRICT_RESPONSE_IDENTITY_POLICY, KNOWN_ECNU_RESPONSE_IDENTITY_POLICY,
            }):
        raise EvaluationBudgetAbort("evaluation_policy_invalid")


class ECNUEvaluationContract:
    """在同一预算发送前核对冻结资料、时间和具名工具请求。"""

    def __init__(
        self, *, deadline: datetime, repo_root: Path,
        source_hashes: dict[str, str],
        clock: Callable[[], datetime] | None = None,
        verification_tool_choice: str = "forced",
        response_identity_policy: str = STRICT_RESPONSE_IDENTITY_POLICY,
        provider_profile: EvaluationProviderProfile | str = EvaluationProviderProfile.ECNU,
    ):
        validate_evaluation_policy(verification_tool_choice, response_identity_policy)
        try:
            self._profile = EvaluationProviderProfile(provider_profile)
        except (TypeError, ValueError):
            raise EvaluationBudgetAbort("evaluation_provider_profile_invalid") from None
        if (self._profile is EvaluationProviderProfile.DEEPSEEK_FLASH_MAX
                and response_identity_policy != STRICT_RESPONSE_IDENTITY_POLICY):
            raise EvaluationBudgetAbort("evaluation_official_identity_policy_invalid")
        self._verification_tool_choice = verification_tool_choice
        self._response_identity_policy = response_identity_policy
        self._deadline = deadline
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._source_hashes = dict(source_hashes)
        try:
            if not stat.S_ISDIR(repo_root.lstat().st_mode):
                raise ValueError("not_regular_directory")
            self._root = repo_root.resolve(strict=True)
            root_identity = self._root.stat()
            self._root_identity = (root_identity.st_dev, root_identity.st_ino)
        except (OSError, ValueError):
            raise EvaluationBudgetAbort("evaluation_source_root_invalid") from None
        self._expected: ContextVar[bytes | None] = ContextVar(
            "ecnu_expected_request", default=None,
        )
        self._identity_observed = False
        self._response_identity: str | None = None
        self._check_deadline()
        self._check_sources()

    def _check_deadline(self) -> None:
        try:
            now = self._clock()
            if (not isinstance(self._deadline, datetime)
                    or not isinstance(now, datetime)
                    or self._deadline.utcoffset() is None
                    or now.utcoffset() is None):
                raise ValueError("unverified_deadline")
            expired = now >= self._deadline
        except Exception:
            raise EvaluationBudgetAbort("evaluation_deadline_invalid") from None
        if expired:
            raise EvaluationBudgetAbort("evaluation_deadline_expired")

    def _check_sources(self) -> None:
        try:
            if not self._source_hashes:
                raise ValueError("empty_source_freeze")
            with ExitStack() as descriptors:
                root_fd = os.open(
                    self._root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                )
                descriptors.callback(os.close, root_fd)
                identity = os.fstat(root_fd)
                if (identity.st_dev, identity.st_ino) != self._root_identity:
                    raise ValueError("root_replaced")
                for name, expected in self._source_hashes.items():
                    path = Path(name)
                    if (
                        not isinstance(name, str) or path.is_absolute()
                        or name != path.as_posix() or ".." in path.parts
                        or path.suffix not in {".py", ".toml", ".md", ".json"}
                        or any(part.startswith(".") and part != ".scratch"
                               for part in path.parts)
                        or not isinstance(expected, str)
                        or re.fullmatch(r"[0-9a-f]{64}", expected) is None
                    ):
                        raise ValueError("source_path_forbidden")
                    with ExitStack() as file_descriptors:
                        parent_fd = root_fd
                        for part in path.parts[:-1]:
                            parent_fd = os.open(
                                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=parent_fd,
                            )
                            file_descriptors.callback(os.close, parent_fd)
                        descriptor = os.open(
                            path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                            dir_fd=parent_fd,
                        )
                        file_descriptors.callback(os.close, descriptor)
                        value = os.fstat(descriptor)
                        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                                or value.st_size > 8 * 1024 * 1024):
                            raise ValueError("source_not_regular")
                        digest = hashlib.sha256()
                        while chunk := os.read(descriptor, 65536):
                            digest.update(chunk)
                        if digest.hexdigest() != expected:
                            raise ValueError("source_digest_changed")
        except (OSError, ValueError, TypeError):
            raise EvaluationBudgetAbort("evaluation_source_freeze_changed") from None

    @contextmanager
    def expect_request(self, expected_payload: dict) -> Iterator[None]:
        """为一次 E/V 调用及其 SDK 重试绑定原定请求正文。"""
        _validate_payload(expected_payload, verification_tool_choice=self._verification_tool_choice,
                          provider_profile=self._profile)
        token = self._expected.set(_canonical(expected_payload))
        try:
            yield
        finally:
            self._expected.reset(token)

    def check_request(self, request: httpx.Request) -> None:
        self.check_preflight()
        if self._expected.get() is None:
            raise EvaluationBudgetAbort("evaluation_request_unbound")
        if request.method != "POST" or str(request.url) != self._profile.endpoint:
            raise EvaluationBudgetAbort("evaluation_endpoint_changed")
        try:
            actual = _canonical(_decode_json(request.content))
        except (ValueError, TypeError, UnicodeError):
            raise EvaluationBudgetAbort("evaluation_request_body_invalid") from None
        if actual != self._expected.get():
            raise EvaluationBudgetAbort("evaluation_request_body_changed")

    def check_preflight(self) -> None:
        """领取后、凭据读取前与每个真实请求前复核同一时效和来源。"""
        self._check_deadline()
        self._check_sources()

    def observe_response(self, response: httpx.Response) -> None:
        """仅成功 Completion 参与服务报告字段比较，不认证权重身份。"""
        if not response.is_success:
            return
        try:
            value = _decode_json(response.content)
            choices = value["choices"]
            identity = value.get("model")
            if (
                value.get("object") != "chat.completion"
                or not isinstance(value.get("id"), str) or not value["id"]
                or type(value.get("created")) is not int or value["created"] < 0
                or not isinstance(choices, list) or not choices
                or any(
                    not isinstance(choice, dict) or type(choice.get("index")) is not int
                    or choice["index"] < 0
                    or not isinstance(choice.get("message"), dict)
                    or choice["message"].get("role") != "assistant"
                    or (choice["message"].get("content") is not None
                        and not isinstance(choice["message"]["content"], str))
                    or not _valid_tool_calls(choice["message"].get("tool_calls"))
                    or choice.get("finish_reason") not in {
                        "stop", "length", "tool_calls", "content_filter", "function_call",
                    }
                    for choice in choices
                )
                or (identity is not None
                    and (not isinstance(identity, str) or not identity.strip()))
            ):
                raise ValueError("invalid_completion")
        except (ValueError, TypeError, KeyError, UnicodeError, AttributeError):
            raise EvaluationBudgetAbort("evaluation_completion_invalid") from None
        if (self._profile is EvaluationProviderProfile.DEEPSEEK_FLASH_MAX
                and identity != "deepseek-flash"):
            raise EvaluationBudgetAbort("evaluation_official_reported_model_changed")
        if self._response_identity_policy == KNOWN_ECNU_RESPONSE_IDENTITY_POLICY:
            # 请求已绑定既有ECNU端点/ecnu-max；已授权标签只作实际观测。
            # 已知集合内变化不能推定相同权重或供应商变化。
            if self._expected.get() is None or identity not in KNOWN_ECNU_RESPONSE_LABELS:
                raise EvaluationBudgetAbort("evaluation_ecnu_reported_label_unapproved")
            return
        if self._identity_observed and identity != self._response_identity:
            raise EvaluationBudgetAbort("evaluation_response_identity_changed")
        self._identity_observed = True
        self._response_identity = identity


def _canonical(value: dict) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _decode_json(content: bytes) -> dict:
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        value: dict = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate_json_key")
            value[key] = item
        return value

    def invalid_number(value: str) -> None:
        raise ValueError("invalid_json_number")

    return json.loads(
        content, object_pairs_hook=unique_object, parse_constant=invalid_number,
    )


def _validate_payload(value: dict, *, verification_tool_choice: str = "forced",
                      provider_profile: EvaluationProviderProfile = EvaluationProviderProfile.ECNU) -> None:
    try:
        function = value["tools"][0]["function"]
        official = provider_profile is EvaluationProviderProfile.DEEPSEEK_FLASH_MAX
        forced = not (official or verification_tool_choice == "omitted"
                      and function["name"] == "SourceVerificationOutput")
        fields = _PAYLOAD_FIELDS if forced else _PAYLOAD_FIELDS - {"tool_choice"}
        if official:
            fields = fields | {"reasoning_effort"}
        if (
            not isinstance(value, dict) or set(value) != fields
            or value["model"] != provider_profile.model
            or (official and value.get("reasoning_effort") != "max")
            or type(value["temperature"]) not in (float, int)
            or value["temperature"] != 0
            or value["stream"] is not False
            or value["thinking"] != {"type": "enabled"}
            or not isinstance(value["messages"], list)
            or len(value["messages"]) != 2
            or any(
                not isinstance(message, dict)
                or set(message) != {"role", "content"}
                or message["role"] != role
                or not isinstance(message["content"], str)
                for message, role in zip(value["messages"], ("system", "user"))
            )
            or not isinstance(value["tools"], list) or len(value["tools"]) != 1
        ):
            raise ValueError("invalid_request_parameters")
        tool = value["tools"][0]
        function = tool["function"]
        if (
            set(tool) != {"type", "function"} or tool["type"] != "function"
            or not isinstance(function, dict)
            or not set(function) <= {"name", "description", "parameters"}
            or function["name"] not in _TOOL_NAMES
            or not isinstance(function["parameters"], dict)
            or (forced and value["tool_choice"] != {
                "type": "function", "function": {"name": function["name"]},
            })
        ):
            raise ValueError("invalid_named_tool")
        _canonical(value)
    except (ValueError, TypeError, KeyError, IndexError, UnicodeError):
        raise EvaluationBudgetAbort("evaluation_expected_payload_invalid") from None


def _valid_tool_calls(value: object) -> bool:
    if value is None:
        return True
    return isinstance(value, list) and all(
        isinstance(item, dict)
        and item.get("type") == "function"
        and isinstance(item.get("id"), str) and bool(item["id"])
        and isinstance(item.get("function"), dict)
        and isinstance(item["function"].get("name"), str)
        and bool(item["function"]["name"])
        and isinstance(item["function"].get("arguments"), str)
        for item in value
    )
