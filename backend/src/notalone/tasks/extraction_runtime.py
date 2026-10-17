"""指定任务的运行选择；调用者只选封闭模式，规则摘要由服务端取得。"""

from notalone.memory_extraction.verification import SourceVerificationMode, SourceVerificationRuntime
from notalone.tasks.models import ExtractionRuntimeConfig, ExtractionRuntimeMode


def validate_runtime_config(config: ExtractionRuntimeConfig | None) -> None:
    """重核已保存的封闭配置；不替任务升级规则或回落到旧合同。"""
    if config is None:
        return
    if type(config) is not ExtractionRuntimeConfig:
        raise ValueError("指定任务运行配置无效。")
    if config.mode is ExtractionRuntimeMode.BOUNDED_RUNTIME_V1:
        from notalone.memory_extraction.source_proof import bounded_runtime_rule_set_sha256

        if config.rule_set_sha256 != bounded_runtime_rule_set_sha256():
            raise ValueError("已固定的提取规则当前不可执行。")


def verification_runtime_for_config(
    runtime: SourceVerificationRuntime | None, config: ExtractionRuntimeConfig | None,
) -> SourceVerificationRuntime | None:
    """只选择同一次V的严格合同；缺省保持既有注入行为。"""
    validate_runtime_config(config)
    if config is None:
        return runtime
    mode = (SourceVerificationMode.LEGACY_V4 if config.mode is ExtractionRuntimeMode.LEGACY
            else SourceVerificationMode.NULLABLE_PROOF_V3)
    select = getattr(runtime, "for_mode", None)
    if not callable(select):
        raise ValueError("来源核验适配器不支持指定任务模式。")
    selected = select(mode)
    if getattr(selected, "verification_mode", None) != mode:
        raise ValueError("指定任务与来源核验合同不符。")
    return selected


def runtime_config_for_mode(mode: ExtractionRuntimeMode) -> ExtractionRuntimeConfig:
    if not isinstance(mode, ExtractionRuntimeMode):
        raise ValueError("指定任务运行模式无效。")
    if mode is ExtractionRuntimeMode.LEGACY:
        return ExtractionRuntimeConfig(mode, None)
    from notalone.memory_extraction.source_proof import bounded_runtime_rule_set_sha256

    return ExtractionRuntimeConfig(mode, bounded_runtime_rule_set_sha256())
