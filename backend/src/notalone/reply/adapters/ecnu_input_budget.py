"""已批准 ECNU 文字请求的输入估算配置，不调用模型或保存正文。"""

from langchain_deepseek import ChatDeepSeek

from notalone.reply.adapters.chat_json_input_budget import ChatJsonInputTokenCounter
from notalone.reply.input_budget import InputBudgetProfile, TokenMeasurementKind


ECNU_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"
ECNU_MODEL = "ecnu-max"
ECNU_OUTPUT_RESERVE = 4096
ECNU_MEASUREMENT_ID = "ecnu-max-chat-json-utf8-framing-estimate-v1"


def build_ecnu_input_budget(model: object) -> tuple[InputBudgetProfile, ChatJsonInputTokenCounter] | None:
    """只有已批准接收地址与模型才自动装配；其他配置保持能力未知。"""

    if not isinstance(model, ChatDeepSeek) or model.model_name != ECNU_MODEL:
        return None
    profile = InputBudgetProfile(
        model_id=ECNU_MODEL, context_window_tokens=512000,
        output_reserve_tokens=ECNU_OUTPUT_RESERVE, warning_ratio=0.8,
        measurement_kind=TokenMeasurementKind.APPROXIMATE,
        measurement_id=ECNU_MEASUREMENT_ID, safety_margin_tokens=65536,
    )
    try:
        counter = ChatJsonInputTokenCounter(model, profile=profile, base_url=ECNU_BASE_URL)
    except (TypeError, ValueError, AttributeError):
        return None
    return profile, counter
