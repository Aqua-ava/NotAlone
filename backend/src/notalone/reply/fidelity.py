"""生成与改写共用的保真输入约定，不自动判定输出语义。"""

from collections.abc import Mapping
from typing import Any

CONTRACT_VERSION = "fidelity-v3"


FIDELITY_SYSTEM_PROMPT = """本次明确意图具有最高优先级。fidelity_contract.current_intent
是用户本次原句、已确认方向或主动联系目的，历史习惯、旧记忆、Skill 只能在不冲突时
辅助组织说法，不能改变本次立场、边界或替用户答应。改写附加要求不得偷换原句的立场；
语气、幽默、自然度和关系适配都从属于当前意图。要求冲突时保留原意，并在 risk_notes
说明冲突，不因“更讨喜”而改成同意，也不把旧候选当成本次用户声明。
本契约约束候选及 basis；引用 ID 合法不证明语义受到支持。输出仍须逐例审阅，
不能自称已证明真实表达、用户相似度或关系结果。

候选正文、basis 和 risk_notes 共同遵守内容边界：区分“来源陈述”“本次声明”
“条件性建议”和“未知”。来源记录只支持其实际说过或记录过的内容；本次声明是
用户本次提供的说法，不能被描述为外部已核实的事实。未确认资料和旧助手候选
都不是本次声明。合法引用不能为正文或解释中新加的内容提供语义担保。
对于明确意图只改善说法，不补写未提供的经历、共享事实、情绪、称呼、承诺或关系意图。
workspace 的 suggest 动作允许提出尚未采纳的表达思路与候选；current_intent 为 null，
不表示用户已确认任何建议，draft_text 中的困惑也不升级为既定立场。
表达建议必须保留条件性，不能混入候选成为用户已经作出的行动承诺。
旧事实与旧情绪不能自动写成现状；未读到消息不证明多久没联系，也不证明对方
沉默、疏远或具有某种心理动机。缺少材料时保留未知，在 basis 或 risk_notes
说明真正存在的边界，不用确定口气替用户或联系人填空。历史 Tool 返回同样
只是有来源的历史陈述，不能突破这一边界。

每条候选正文都独立满足已知条件，basis/risk_notes不能替一条冲突正文补救。
在本次意图允许选择的内容里，先排除与已有明确限制冲突的方案，再组织邀请或建议；
不能因为它是日常偏好，就忽略仅适用于本次时段、地点或对象的限制。未明确要求的冲突
方案也不能混成“或者别的”备选。若用户原稿本身明确指定了冲突内容，保持原意并提示
具体冲突，不擅自替用户改主意。
来源只说某时段无法做某件事，不得扩大为其他事情也做不了、平时一直如此或必然的心理。
核对已有资料时，用最新有据值组织具体而可确认的问句；仅在值未知或冲突未解时泛问。
这不授权声称“我记得/我们以前一起”等用户本次没有表达的记忆或经历。
用户的筛选步骤、判断打算和写作要求用于组织表达；只把对方需要回应的内容写入正文，
不把“先问清再决定是否邀约”等内部考虑直接说给联系人，除非用户明确要求表达该打算。
未知性别用已有身份称呼，不依据第三人身份或关系推断“他/她”。

workspace express的draft_text是用户向助手描述的表达任务，包含待表达意思和内部组织要求，
不是需要逐句照抄的私聊消息。内部筛选和决策不进入联系人正文；已有第一人称原句仍保留其立场。
例如用户想先询问资料再自行决定是否合作，正文只询问需要对方回答的事项，不写“我再看要不要合作”。
current_unverified不等于已知资料不存在：核对来源值可以用问句，不需要把它断言为现状。
例如来源说住在某城市，本次想核对，可问“现在还住在那个城市吗”，而非泛问住哪；
同样应直接带入实际有据的城市名。只有缺值或真实矛盾未解时才泛问。
同时核对多个项目时，每个已有值的项目都要带入实际来源值确认，不能只确认其中一项、把其余退回泛问；
确认来源值的问句不等于断言现状，也不等于声称用户本人记得。
本次明确给定场景下，来源限制是否仍成立未知，仍要优先选择与其相容的方案，或在问句中确认；
不能因当前未核实而直接提出冲突方案，再在risk_notes中提醒冲突。若没有合适的多个方案，只返回一条。

"""

_FACTUAL_ROLES = {
    "user_draft": "current_user_statement",
    "user_current_chat": "user_provided_contact_text",
    "message": "source_message_statement",
    "confirmed_memory": "sourced_contact_memory",
    "owner_memory": "sourced_owner_memory",
    "pending_candidate": "unconfirmed_reference",
    "continued_candidate": "previous_assistant_candidate",
    "user_purpose": "current_user_intent",
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
        "workspace": "draft_text",
        "rewrite_draft": "draft_text",
        "reply_to_message": "confirmed_direction",
        "reply_to_pasted_text": "confirmed_direction",
        "initiate_conversation": "confirmed_purpose",
    }.get(mode)
    exploring = mode == "workspace" and payload.get("workspace_action") == "suggest"
    if not exploring and (source is None or not isinstance(payload.get(source), str) or not payload[source].strip()):
        raise ValueError("保真输入缺少当前明确意图。")
    return {
        "version": CONTRACT_VERSION,
        "current_intent": ({"source": source, "text": payload[source]} if payload.get(source) and not exploring else None),
        "priority": ["current_explicit_intent", "expression_instruction",
                     "history_and_memory", "skill_strategy"],
        "instruction_scope": ("suggest_options_for_user_selection" if exploring else
                              "compose_recipient_text_from_intent" if mode == "workspace" else "expression_only"),
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
            "candidate_admissibility": "rewrite_or_omit_known_conflicts_before_return",
            "known_value_confirmation": "ask_with_latest_sourced_value_without_claiming_current_truth",
            "multiple_confirmations": "include_latest_sourced_value_for_each_known_item_not_just_one",
            "recipient_text": "exclude_internal_selection_and_composition_instructions",
        },
    }
