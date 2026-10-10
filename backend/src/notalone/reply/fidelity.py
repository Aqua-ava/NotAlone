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
style_references仅为低权重说法参考，其中的事实、时间、情绪、称呼和承诺
不属于本次可用事实。sample_id不能作为citation_ids；实际使用记录只说明
参考了哪份表达，不能证明候选内容受到支持。与本次意图冲突时保留本次意图。

候选正文、basis 和 risk_notes 共同遵守内容边界：区分“来源陈述”“本次声明”
“条件性建议”和“未知”。来源记录只支持其实际说过或记录过的内容；本次声明是
用户本次提供的说法，不能被描述为外部已核实的事实。未确认资料和旧助手候选
都不是本次声明。合法引用不能为正文或解释中新加的内容提供语义担保。
只改善说法，不补写未提供的经历、共享事实、情绪、称呼、承诺或关系意图。
表达建议必须保留条件性，不能混入候选成为用户已经作出的行动承诺。
旧事实与旧情绪不能自动写成现状；未读到消息不证明多久没联系，也不证明对方
沉默、疏远或具有某种心理动机。缺少材料时保留未知，在 basis 或 risk_notes
说明真正存在的边界，不用确定口气替用户或联系人填空。历史 Tool 返回同样
只是有来源的历史陈述，不能突破这一边界。

"""

_FACTUAL_ROLES = {
    "user_draft": "current_user_statement",
    "message": "source_message_statement",
    "confirmed_memory": "sourced_contact_memory",
    "owner_memory": "sourced_owner_memory",
    "pending_candidate": "unconfirmed_reference",
    "continued_candidate": "previous_assistant_candidate",
    "user_purpose": "current_user_intent",
    "style_sample": "expression_reference",
}


def factual_role(kind: str) -> str:
    """材料来历分类，不把来源合法性升级为内容真实或当前有效。"""

    try:
        return _FACTUAL_ROLES[kind]
    except KeyError:
        raise ValueError("保真材料类型无效。") from None


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
        "content_boundary": {
            "output_scope": ["candidate_text", "basis", "risk_notes"],
            "current_user_statement": "user_declared_not_externally_verified",
            "source_statement": "limited_to_sourced_content_and_time",
            "conditional_advice": "not_a_user_fact_or_commitment",
            "unknown": "retain_unknown_without_filling_in",
            "historical_state": "not_automatically_current",
            "missing_history": "does_not_establish_contact_gap_or_motive",
            "citation_validity": "does_not_prove_semantic_support",
        },
    }
