"""官方 DeepSeek Flash 的文字输入估算；端点与模型均精确核对。"""

from notalone.reply.adapters.chat_json_input_budget import ChatJsonInputTokenCounter
from notalone.reply.adapters.deepseek_provider import is_official_deepseek_flash
from notalone.reply.input_budget import InputBudgetProfile, TokenMeasurementKind

DEEPSEEK_REVIEW_BASE_URL = "https://api.deepseek.com/beta"


def build_deepseek_input_budget(model: object, *, allow_beta: bool = False
                                ) -> tuple[InputBudgetProfile, ChatJsonInputTokenCounter] | None:
    """按官方 /models 合同装配 Flash；未知模型和代理不沿用容量。"""

    from langchain_deepseek import ChatDeepSeek

    review_route = (allow_beta and type(model) is ChatDeepSeek
                    and model.model_name == "deepseek-flash"
                    and str(model.root_client.base_url).rstrip("/") == DEEPSEEK_REVIEW_BASE_URL)
    if not is_official_deepseek_flash(model) and not review_route:
        return None
    # api_base 未显式设置时，也核对 SDK 实际接收地址。
    base_url = str(model.root_client.base_url).rstrip("/")
    profile = InputBudgetProfile(
        model_id="deepseek-flash", context_window_tokens=1048576,
        output_reserve_tokens=4096, warning_ratio=0.8,
        measurement_kind=TokenMeasurementKind.APPROXIMATE,
        measurement_id="deepseek-flash-chat-json-utf8-framing-estimate-v1",
        safety_margin_tokens=65536,
    )
    try:
        counter = ChatJsonInputTokenCounter(model, profile=profile, base_url=base_url)
    except (TypeError, ValueError, AttributeError):
        return None
    return profile, counter
