"""ECNU、官方最高思考及固定分阶段评测契约；生产路径不引用此门。"""

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
from typing import Callable, Iterator, TypedDict

import httpx

from .evaluation_http_budget import EvaluationBudgetAbort
from .evaluation_extraction import EvaluationExtractionMode, extraction_tool_name
from .evaluation_bounded_cases import BOUNDED_RUNTIME_PLAN
from .grounded_adapter import BOUNDED_STAGE_PROMPT_PROFILE


_ENDPOINT = "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"
_PAYLOAD_FIELDS = frozenset({
    "model", "temperature", "stream", "thinking", "messages", "tools", "tool_choice",
})
STRICT_RESPONSE_IDENTITY_POLICY = "first_valid_completion_observation_stop_on_change"
KNOWN_ECNU_RESPONSE_IDENTITY_POLICY = "ecnu_configured_route_known_labels_v1"
KNOWN_ECNU_RESPONSE_LABELS = frozenset({"deepseek-v4-flash", "deepseek-flash"})
MIXED_PLAN = "full140-grounded-v4-source-v2-v-off-forced"
MIXED_REQUEST_VERSION = "deepseek-phase-split-v1"
MIXED_MODE = "deepseek_bounded_full140_v4_source_v2_v_off_forced"
MIXED_STAGE = "full140-v4-source-v2-v-off-forced"
MIXED_KIND = "full140-v4-v-off-forced"
REFERENCE21_V4_PLAN = "reference21-grounded-v4-source-v2-v-off-forced"
REFERENCE21_V4_MODE = "deepseek_bounded_reference21_v4_source_v2_v_off_forced"
REFERENCE21_V4_STAGE = "reference21-v4-source-v2-v-off-forced"
REFERENCE21_V4_KIND = "reference21-v4-v-off-forced"
SEMANTIC4_PLAN = "reference21-grounded-v4-source-v2-semantic4-v-off-forced"
SEMANTIC4_MODE = "deepseek_bounded_reference21_v4_source_v2_semantic4"
SEMANTIC4_STAGE = "reference21-v4-source-v2-semantic4"
SEMANTIC4_KIND = "reference21-v4-semantic4"
SEMANTIC4_PROMPT_PROFILE = "public-author-quote-v1"
UNIQUENESS_PLAN = "reference21-grounded-v4-source-v2-uniqueness-v-off-forced"
UNIQUENESS_MODE = "deepseek_bounded_reference21_v4_source_v2_uniqueness"
UNIQUENESS_STAGE = "reference21-v4-source-v2-uniqueness"
UNIQUENESS_KIND = "reference21-v4-uniqueness"
UNIQUENESS_E_PROFILE = "reference-uniqueness-v1"
PUBLIC_QUALITY_PLANS = frozenset({SEMANTIC4_PLAN, UNIQUENESS_PLAN})
REFERENCE21_PLANS = frozenset({REFERENCE21_V4_PLAN, *PUBLIC_QUALITY_PLANS})
FULL140_E2_PLAN = "full140-grounded-v2-source-v2-v-off-forced"
FULL140_E2_MODE = "deepseek_bounded_full140_v2_source_v2_v_off_forced"
FULL140_E2_STAGE = "full140-v2-source-v2-v-off-forced"
FULL140_E2_KIND = "full140-v2-v-off-forced"
PHASE_SPLIT_PLANS = frozenset({MIXED_PLAN, FULL140_E2_PLAN, *REFERENCE21_PLANS})
BOUNDED_RUNTIME_MODE = "deepseek_bounded_runtime15"
BOUNDED_RUNTIME_STAGE = "bounded-runtime15"
BOUNDED_RUNTIME_KIND = "bounded-runtime15"
_BOUNDED_MIGRATION_SOURCES = frozenset(
    f"backend/database/migrations/{name}" for name in (
        "001_initial_ingest.sql", "002_reject_overlapping_messages.sql", "003_separate_contact_identity.sql",
        "004_separate_wechat_message_metadata.sql", "005_source_deletion_state.sql", "006_conversation_binding.sql",
        "007_reply_store.sql", "008_skill_port.sql", "009_memory_store.sql", "010_outbound_ledger.sql",
        "011_owner_memory.sql", "012_extraction_topic_watermark.sql", "013_candidate_validity.sql",
        "014_import_message_identity.sql", "015_owner_channel_identity.sql", "016_background_task.sql",
        "017_worker_lease_metadata.sql", "018_contact_memory_index.sql", "019_binding_cli_match_metadata.sql",
        "020_local_wechat_observation.sql", "021_message_source_ref.sql", "022_front_sync_state.sql",
        "023_skill_library_resources.sql", "024_skill_run_record.sql", "025_manual_memory_source.sql",
        "026_cli_background_sync.sql", "027_memory_adoption_provenance.sql", "028_reply_context_evidence_metadata.sql",
        "029_cli_backfill_state.sql", "030_cli_observation_reliability_and_progress.sql", "031_cli_backfill_scheduler.sql",
        "032_memory_candidate_subject.sql", "033_owner_memory_evidence_kind.sql", "034_extraction_failure_recovery.sql",
        "035_extraction_watermark_cascade.sql", "036_source_deletion_tasks.sql", "037_pending_candidate_evidence_kind.sql",
        "038_memory_candidate_interpretation.sql", "039_memory_extraction_trace.sql", "040_source_processing_trace.sql",
        "041_source_processing_capture_tombstone.sql", "042_extraction_trace_call_receipts.sql",
        "043_extraction_trace_record_operations.sql", "044_owner_memory_versioning.sql", "045_observation_background_task.sql",
        "046_background_step_lease_generation.sql", "047_observation_memory_enqueue_receipt.sql",
        "048_assistant_sessions.sql", "049_style_samples.sql", "050_reply_purpose_evidence.sql",
        "051_assistant_session_inputs.sql", "052_reply_exploration.sql", "053_assistant_candidate_versions.sql",
        "054_assistant_generation_interruption.sql", "055_assistant_candidate_carry_input.sql",
        "056_memory_candidate_dimension_evidence.sql", "057_memory_candidate_semantic_basis.sql",
        "058_assistant_prepared_context.sql", "059_memory_candidate_author_quote_basis.sql", "060_manual_contact_confirmation.sql", "061_memory_correction_protection.sql", "062_memory_events_and_version_evidence.sql", "063_relationship_overview_projection.sql", "064_owner_memory_revision.sql", "065_expression_preferences.sql", "066_skill_learning_drafts.sql", "067_memory_upgrade_batches.sql", "068_skill_review_publication.sql", "069_skill_history_operations.sql", "070_skill_scope_policies.sql", "071_bounded_runtime_evidence.sql", "072_scoped_media_lifecycle.sql",
    )
)


def validate_extraction_prompt_profile(execution_plan: str, prompt_profile: str) -> None:
    """新提示须与唯一新身份绑定，旧身份只允许原默认。"""
    expected = (BOUNDED_STAGE_PROMPT_PROFILE if execution_plan == BOUNDED_RUNTIME_PLAN
                else UNIQUENESS_E_PROFILE if execution_plan == UNIQUENESS_PLAN else "default")
    if type(prompt_profile) is not str or prompt_profile != expected:
        raise EvaluationBudgetAbort("evaluation_extraction_prompt_profile_mismatch")


def validate_semantic4_windows(windows: tuple) -> None:
    """公开质量合同不接受受控或混合来源；在预算与凭据前核验。"""
    from .models import ExtractionWindow, MessageRef
    if (type(windows) is not tuple or len(windows) != 21
            or any(type(window) is not ExtractionWindow or not window.messages or any(
                type(message) is not MessageRef or message.source_snapshots != () or message.message_snapshot != {}
                or message.message_type != "unknown" or message.text_representation != "unknown"
                for message in window.messages) for window in windows)):
        raise EvaluationBudgetAbort("evaluation_semantic4_public_sources_required")


def mixed_phase_policy() -> dict:
    """返回唯一新配对的副本；不是调用者可配置的策略表。"""
    return {
        "extraction": {"thinking_mode": "enabled", "reasoning_effort": "max", "tool_choice_mode": "omitted"},
        "verification": {"thinking_mode": "disabled", "reasoning_effort": "none", "tool_choice_mode": "forced"},
    }


class _OutputParameters(TypedDict, total=False):
    max_tokens: int


REFERENCE16_PRO_PLAN = "reference16-pro-v1"
REFERENCE16_PRO_MODE = "deepseek_bounded_reference16_pro"
REFERENCE16_PRO_STAGE = "reference16-pro"
REFERENCE16_PRO_KIND = "reference16-pro"


class EvaluationProviderProfile(StrEnum):
    """仅已注册的封闭评测配置；不接受任意端点或生产配置覆盖。"""

    ECNU = "ecnu"
    DEEPSEEK_FLASH_MAX = "deepseek-flash-max"
    DEEPSEEK_PHASE_SPLIT = "deepseek-phase-split-v1"
    DEEPSEEK_BOUNDED_TASK = "deepseek-bounded-task-v1"
    DEEPSEEK_PRO_BOUNDED_TASK = "deepseek-pro-bounded-task-v1"
    DEEPSEEK_PRO_REFERENCE16 = "deepseek-pro-reference16-v1"

    @property
    def is_official(self) -> bool:
        return self in {self.DEEPSEEK_FLASH_MAX, self.DEEPSEEK_PHASE_SPLIT, self.DEEPSEEK_BOUNDED_TASK, self.DEEPSEEK_PRO_BOUNDED_TASK, self.DEEPSEEK_PRO_REFERENCE16}

    @property
    def is_pro(self) -> bool:
        return self in {self.DEEPSEEK_PRO_BOUNDED_TASK, self.DEEPSEEK_PRO_REFERENCE16}

    @property
    def is_bounded(self) -> bool:
        return self in {self.DEEPSEEK_BOUNDED_TASK, self.DEEPSEEK_PRO_BOUNDED_TASK}

    @property
    def output_parameters(self) -> _OutputParameters:
        return {"max_tokens": 8192} if self.is_pro else {}

    @property
    def base_url(self) -> str:
        return ("https://api.deepseek.com" if self.is_official
                else "https://chat.ecnu.edu.cn/open/api/v1")

    @property
    def endpoint(self) -> str:
        return self.base_url + "/chat/completions"

    @property
    def model(self) -> str:
        if self.is_pro:
            return "deepseek-v4-pro"
        return "deepseek-flash" if self.is_official else "ecnu-max"


def bounded_profile_for_config(config: dict) -> EvaluationProviderProfile:
    """旧登记保持原字节，新登记必须同时绑定唯一profile、模型和输出上限。"""
    version = config.get("request_contract_version")
    if type(version) is int and version == 2 and not {"provider_profile", "max_tokens"} & set(config):
        profile = EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK
    elif (type(version) is int and version == 3
            and type(config.get("provider_profile")) is str
            and config["provider_profile"] == EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK.value
            and type(config.get("max_tokens")) is int and config["max_tokens"] == 8192):
        profile = EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK
    else:
        raise EvaluationBudgetAbort("evaluation_bounded_profile_registration_invalid")
    if config.get("request_model") != profile.model:
        raise EvaluationBudgetAbort("evaluation_bounded_profile_model_mismatch")
    return profile


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
        extraction_mode: EvaluationExtractionMode | str = EvaluationExtractionMode.LEGACY_E14,
        execution_plan: str = "original",
        extraction_prompt_profile: str = "default",
    ):
        validate_evaluation_policy(verification_tool_choice, response_identity_policy)
        validate_extraction_prompt_profile(execution_plan, extraction_prompt_profile)
        self._extraction_prompt_profile = extraction_prompt_profile
        try:
            self._extraction_mode = EvaluationExtractionMode(extraction_mode)
        except (TypeError, ValueError):
            raise EvaluationBudgetAbort("evaluation_extraction_mode_invalid") from None
        try:
            self._profile = EvaluationProviderProfile(provider_profile)
        except (TypeError, ValueError):
            raise EvaluationBudgetAbort("evaluation_provider_profile_invalid") from None
        if (type(execution_plan) is not str or
                (self._profile is EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT) != (execution_plan in PHASE_SPLIT_PLANS)):
            raise EvaluationBudgetAbort("evaluation_mixed_fixed_plan_required")
        if self._profile is EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT and (
                verification_tool_choice != "forced" or self._extraction_mode is not (
                    EvaluationExtractionMode.GROUNDED_V2 if execution_plan == FULL140_E2_PLAN
                    else EvaluationExtractionMode.GROUNDED_V4)):
            raise EvaluationBudgetAbort("evaluation_mixed_fixed_plan_required")
        bounded = self._profile.is_bounded
        reference16 = self._profile is EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16
        if reference16 != (execution_plan == REFERENCE16_PRO_PLAN) or reference16 and (
                verification_tool_choice != "forced" or self._extraction_mode is not EvaluationExtractionMode.GROUNDED_V2):
            raise EvaluationBudgetAbort("evaluation_reference16_pro_fixed_plan_required")
        if bounded != (execution_plan == BOUNDED_RUNTIME_PLAN) or bounded and (
                verification_tool_choice != "forced" or self._extraction_mode is not EvaluationExtractionMode.GROUNDED_V2):
            raise EvaluationBudgetAbort("evaluation_bounded_fixed_plan_required")
        if (self._profile.is_official
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
                        or (path.suffix not in {".py", ".toml", ".md", ".json"}
                            and not (self._profile.is_bounded
                                     and name in _BOUNDED_MIGRATION_SOURCES))
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
                          provider_profile=self._profile, extraction_mode=self._extraction_mode)
        if (self._extraction_prompt_profile != "default"
                and self._extraction_mode is EvaluationExtractionMode.GROUNDED_V4
                and expected_payload["tools"][0]["function"]["name"] == "GroundedMemoryLabelsV4"):
            from .grounded_adapter import grounded_v4_prompt
            if expected_payload["messages"][0]["content"] != grounded_v4_prompt(self._extraction_prompt_profile):
                raise EvaluationBudgetAbort("evaluation_extraction_prompt_changed")
        if (self._extraction_prompt_profile == BOUNDED_STAGE_PROMPT_PROFILE
                and expected_payload["tools"][0]["function"]["name"] == "GroundedMemoryLabels"):
            from .grounded_adapter import grounded_v2_prompt
            if expected_payload["messages"][0]["content"] != grounded_v2_prompt(self._extraction_prompt_profile):
                raise EvaluationBudgetAbort("evaluation_extraction_prompt_changed")
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
        if (self._profile.is_official
                and identity != self._profile.model):
            raise EvaluationBudgetAbort("evaluation_official_reported_model_changed")
        if self._profile in {EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT,
                             EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK, EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK, EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16} and (
                len(choices) != 1 or choices[0]["index"] != 0):
            raise EvaluationBudgetAbort("evaluation_completion_invalid")
        if (self._profile.is_pro
                and any(choice["finish_reason"] in {"length", "content_filter"} for choice in choices)):
            raise EvaluationBudgetAbort("evaluation_pro_completion_incomplete")
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
                      provider_profile: EvaluationProviderProfile = EvaluationProviderProfile.ECNU,
                      extraction_mode: EvaluationExtractionMode = EvaluationExtractionMode.LEGACY_E14) -> None:
    try:
        function = value["tools"][0]["function"]
        official = provider_profile.is_official
        reference16 = provider_profile is EvaluationProviderProfile.DEEPSEEK_PRO_REFERENCE16
        mixed_v = provider_profile in {EvaluationProviderProfile.DEEPSEEK_PHASE_SPLIT,
                                       EvaluationProviderProfile.DEEPSEEK_BOUNDED_TASK, EvaluationProviderProfile.DEEPSEEK_PRO_BOUNDED_TASK} and function["name"] == "SourceVerificationOutput"
        non_thinking = mixed_v or reference16
        forced = reference16 or mixed_v or not (official or verification_tool_choice == "omitted"
                      and function["name"] == "SourceVerificationOutput")
        fields = _PAYLOAD_FIELDS if forced else _PAYLOAD_FIELDS - {"tool_choice"}
        if official:
            fields = fields | {"reasoning_effort"}
        fields = fields | set(provider_profile.output_parameters)
        if (
            not isinstance(value, dict) or set(value) != fields
            or value["model"] != provider_profile.model
            or any(type(value.get(key)) is not int or value[key] != expected
                   for key, expected in provider_profile.output_parameters.items())
            or (official and value.get("reasoning_effort") != ("none" if non_thinking else "max"))
            or type(value["temperature"]) not in (float, int)
            or value["temperature"] != 0
            or value["stream"] is not False
            or value["thinking"] != {"type": "disabled" if non_thinking else "enabled"}
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
            or function["name"] not in {extraction_tool_name(extraction_mode), "SourceVerificationOutput"}
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
