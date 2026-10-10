"""生成与改写共用的保真输入约定，不自动判定输出语义。"""

from collections.abc import Mapping
from typing import Any

CONTRACT_VERSION = "fidelity-v1"


FIDELITY_SYSTEM_PROMPT = """本次明确意图具有最高优先级。fidelity_contract.current_intent
是用户本次原句、已确认方向或主动联系目的，历史习惯、旧记忆、Skill 和表达样本只能在不冲突时
辅助组织说法，不能改变本次立场、边界或替用户答应。改写附加要求不得偷换原句的立场；
语气、幽默、自然度和关系适配都从属于当前意图。要求冲突时保留原意，并在 risk_notes
说明冲突，不因“更讨喜”而改成同意，也不把旧候选当成本次用户声明。
本契约约束候选及 basis；引用 ID 合法不证明语义受到支持。输出仍须逐例审阅，
不能自称已证明真实表达、用户相似度或关系结果。

"""


def generation_contract(payload: Mapping[str, Any]) -> dict:
    """保留明确输入的原文字段，不从历史或策略推断用户立场。"""

    mode = payload.get("input_mode")
    source = {
        "rewrite_draft": "draft_text",
        "reply_to_message": "confirmed_direction",
        "initiate_conversation": "confirmed_purpose",
    }.get(mode)
    if source is None or not isinstance(payload.get(source), str) or not payload[source].strip():
        raise ValueError("保真输入缺少当前明确意图。")
    return {
        "version": CONTRACT_VERSION,
        "current_intent": {"source": source, "text": payload[source]},
        "priority": ["current_explicit_intent", "expression_instruction",
                     "history_and_memory", "skill_strategy", "style_reference"],
        "instruction_scope": "expression_only",
        "conflict_action": "preserve_current_intent_and_explain",
    }
