"""升级批准绑定实际运行规则和非秘密生效配置，不绑定聊天正文。"""

from importlib.metadata import version
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from notalone.memory.upgrade import UpgradeAlgorithmChanged
from notalone.memory_extraction.dimensions import DimensionRelease
from notalone.memory_extraction.grounded import GROUNDED_EXTRACTION_PROTOCOL, GROUNDED_COMPILER_VERSION
from notalone.memory_extraction.adoption import DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_SIMILARITY_THRESHOLD


_SOURCE_FILES = (
    "memory_extraction/grounded.py", "memory_extraction/grounded_adapter.py",
    "memory_extraction/models.py", "memory_extraction/evidence.py",
    "memory/models.py", "memory/events.py", "memory/timing.py",
    "memory/candidates.py", "memory/dimension_evidence.py", "memory/evidence_binding.py",
    "memory/pragmatics.py", "memory/versions.py", "memory/version_evidence.py",
    "memory_extraction/verification.py", "memory_extraction/verification_adapters.py",
    "memory_extraction/source_proof.py", "memory_extraction/flow.py",
    "memory_extraction/pragmatics.py", "memory_extraction/dimensions.py",
    "memory_extraction/adoption.py", "memory_extraction/adjudication.py",
    "memory_extraction/adjudication_adapters.py", "memory_extraction/cli_support.py",
    "reply/adapters/deepseek_provider.py", "memory_trace/transport.py",
    "application/memory_upgrade_runtime.py", "application/memory_upgrade.py",
    "application/memory_upgrade_preview.py", "memory/upgrade_snapshot.py",
    "memory/upgrade_algorithm.py", "persistence/memory_upgrade.py",
    "persistence/memory_upgrade_apply.py", "persistence/memory_upgrade_generation.py",
    "persistence/memory_store.py", "persistence/owner_memory_store.py",
    "persistence/dimension_evidence.py", "persistence/memory_events.py",
    "persistence/memory_timing.py", "persistence/memory_versions.py",
    "persistence/memory_correction.py", "persistence/correction_evidence.py",
    "persistence/message_sources.py",
)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def _endpoint(model):
    client = getattr(model, 'root_client', None)
    if client is None:
        return 'synthetic-local'
    endpoint = urlsplit(str(client.base_url))
    if (endpoint.scheme not in ('http', 'https') or not endpoint.hostname
            or endpoint.username is not None or endpoint.password is not None
            or endpoint.query or endpoint.fragment):
        raise UpgradeAlgorithmChanged('升级模型端点必须具有可记录的非秘密身份。')
    return endpoint.geturl()


def upgrade_algorithm(components, runtimes, *, dimension_release=None):
    """从实际builder产物读取模型选项；禁止凭据、任意env及正文进入身份。"""
    model = components.model
    release = DimensionRelease.resolve(dimension_release)
    retry = getattr(model, "max_retries", 0)
    if type(retry) is not int or retry != 0:
        raise UpgradeAlgorithmChanged("升级运行时必须逐HTTP计预算或关闭SDK重试。")
    extra = getattr(model, "extra_body", None) or {}
    configuration = {
        "runtime": {name: type(runtimes[name]).__module__ + "." + type(runtimes[name]).__qualname__
                    for name in ("extraction", "verification", "adjudication")},
        "model_class": type(model).__module__ + "." + type(model).__qualname__,
        "provider": "deepseek", "model_name": getattr(model, "model_name", components.model_name),
        "endpoint": _endpoint(model),
        "max_retries": retry, "temperature": getattr(model, "temperature", 0.0),
        "timeout_seconds": getattr(model, "request_timeout", 60.0),
        "thinking": extra.get("thinking", {}).get("type", "not_applicable"),
        "tool_choice": runtimes["verification"].tool_choice_policy,
        "dimension_gate_enabled": release.gate_enabled,
        "dimension_allowed": sorted(release.allowed),
        "confidence_threshold": DEFAULT_CONFIDENCE_THRESHOLD,
        "similarity_threshold": DEFAULT_SIMILARITY_THRESHOLD,
        "packages": {name: version(name) for name in
                     ("langchain-deepseek", "langchain-core", "langchain-openai", "openai", "pydantic")},
        "code": {name: hashlib.sha256((Path(__file__).resolve().parents[1] / name).read_bytes()).hexdigest()
                 for name in _SOURCE_FILES},
    }
    value = {"version": 1, "protocol": GROUNDED_EXTRACTION_PROTOCOL,
             "compiler": GROUNDED_COMPILER_VERSION,
             "verification_mode": runtimes["verification"].verification_mode.value,
             "configuration": configuration}
    return {**value, "digest": _digest(value)}


def require_upgrade_algorithm(saved, current):
    """旧空指纹不补签；摘要、有效配置和真实规则必须同时一致。"""
    for value in (saved, current):
        if (not isinstance(value, dict) or set(value) != {
                "version", "digest", "protocol", "compiler", "verification_mode", "configuration"}
                or type(value["version"]) is not int or value["version"] != 1
                or not isinstance(value["configuration"], dict)
                or value["digest"] != _digest({key: item for key, item in value.items() if key != "digest"})):
            raise UpgradeAlgorithmChanged("旧升级没有当前可核验的算法身份，请重新预览。")
    if saved != current:
        raise UpgradeAlgorithmChanged("升级算法或配置已变化，请重新预览并明确批准。")
