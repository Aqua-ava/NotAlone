"""主体与事实状态保真的固定合成对照，不包含私人聊天或文字正则评分。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.models import (
    MAX_TARGET_MESSAGES_PER_WINDOW,
    ExtractionWindow,
    MessageRef,
    MessageSender,
)
from notalone.memory_extraction.runtime import ExtractionPayload


@dataclass(frozen=True, slots=True)
class FidelityCandidate:
    """固定候选；每组只改变人物归属或事实状态一个语义维度。"""

    text: str
    subject: Literal["self", "contact", "shared"]
    source_indices: tuple[int, ...]
    speech_act: Literal["assertion", "plan", "report"] = "assertion"
    assertion_status: Literal["asserted", "reported"] = "asserted"


@dataclass(frozen=True, slots=True)
class FidelityGold:
    """按候选序号固定的来源支持与去向答案，不以候选文字匹配答案。"""

    candidate_index: int
    verdict: Literal["supported", "unsupported", "uncertain"]
    issues: tuple[Literal["subject", "pragmatics"], ...]
    expected_destination: Literal["auto", "pending", "none"]
    reason: str


@dataclass(frozen=True, slots=True)
class FidelityCase:
    """消息、目标、两条候选与人工制定答案在模型调用前固定。"""

    case_id: str
    dimension: Literal["subject", "state"]
    messages: tuple[tuple[Literal["self", "contact"], str], ...]
    targets: tuple[int, ...]
    candidates: tuple[FidelityCandidate, FidelityCandidate]
    gold: tuple[FidelityGold, FidelityGold]


def build_fidelity_window(case: FidelityCase) -> ExtractionWindow:
    """构造固定时间、身份隔离和目标边界的合成消息窗口。"""

    if (
        not case.targets
        or len(case.targets) > MAX_TARGET_MESSAGES_PER_WINDOW
        or len(set(case.targets)) != len(case.targets)
        or any(index < 0 or index >= len(case.messages) for index in case.targets)
    ):
        raise ValueError("目标序号必须唯一、属于合成窗口并遵守目标预算。")
    base_time = datetime.fromisoformat("2026-07-06T10:00:00+08:00")
    messages = tuple(
        MessageRef(
            message_id=uuid5(NAMESPACE_URL, f"notalone-fidelity/{case.case_id}/{index}"),
            text=text,
            sender=MessageSender(sender),
            occurred_at=base_time + timedelta(minutes=index),
        ) for index, (sender, text) in enumerate(case.messages)
    )
    return ExtractionWindow(
        owner_id=uuid5(NAMESPACE_URL, "notalone-fidelity/owner"),
        contact_id=uuid5(NAMESPACE_URL, f"notalone-fidelity/contact/{case.case_id}"),
        messages=messages,
        target_message_ids=tuple(messages[index].message_id for index in case.targets),
    )


def candidate_payloads(case: FidelityCase) -> ExtractionPayload:
    """返回固定候选及同一窗口内的来源 ID，不调用模型或自行判断语义。"""

    window = build_fidelity_window(case)
    payloads: list[dict] = []
    for candidate in case.candidates:
        if (
            not candidate.source_indices
            or len(set(candidate.source_indices)) != len(candidate.source_indices)
            or any(index < 0 or index >= len(window.messages)
                   for index in candidate.source_indices)
            or not set(candidate.source_indices) & set(case.targets)
        ):
            raise ValueError("候选来源必须唯一、属于窗口并包含目标消息。")
        payloads.append({
            "text": candidate.text, "category": "common_fact",
            "subject": candidate.subject, "topic": "other",
            "source_message_ids": [str(window.messages[index].message_id)
                                   for index in candidate.source_indices],
            "confidence": 0.9, "risk_flags": [],
            "valid_at": None, "invalid_at": None,
            "speech_act": candidate.speech_act,
            "assertion_status": candidate.assertion_status,
            "figurative_type": "literal", "alternatives": [],
            "interpretation_reason": "合成对照候选，来源支持须由独立核验判断。",
        })
    return tuple(payloads)


FIDELITY_CASES = (
    FidelityCase(
        "subject-01", "subject",
        (("contact", "你平时参加什么活动？"),
         ("self", "我一直在社区做自行车安全讲解。")),
        (1,),
        (FidelityCandidate("用户一直在社区做自行车安全讲解。", "self", (1,)),
         FidelityCandidate("用户一直在社区做自行车安全讲解。", "contact", (1,))),
        (FidelityGold(0, "supported", (), "auto", "第 2 条由用户自述；正文与 self 主体一致。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "第 2 条只支持用户经历；subject=contact 把用户经历归入联系人。")),
    ),
    FidelityCase(
        "subject-02", "subject",
        (("contact", "我在市图书馆做编目员，已经五年了。"),),
        (0,),
        (FidelityCandidate("联系人在市图书馆做编目员已有五年。", "contact", (0,)),
         FidelityCandidate("联系人在市图书馆做编目员已有五年。", "self", (0,))),
        (FidelityGold(0, "supported", (), "auto", "第 1 条由联系人自述职业与年限。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "职业属于联系人；self 字段把它归入用户本人。")),
    ),
    FidelityCase(
        "subject-03", "subject",
        (("contact", "我们俩上个月一起完成了志愿者急救培训。"),),
        (0,),
        (FidelityCandidate("双方上个月一起完成了志愿者急救培训。", "shared", (0,)),
         FidelityCandidate("双方上个月一起完成了志愿者急救培训。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "auto", "第 1 条明确是我们俩共同完成，应归 shared。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "共同经历的正文未变，但 contact 字段把双方经历标成单方。")),
    ),
    FidelityCase(
        "subject-04", "subject",
        (("contact", "恭喜你拿到建筑模型比赛的银奖！"),
         ("self", "谢谢，准备了好几个月。")),
        (0,),
        (FidelityCandidate("用户拿到了建筑模型比赛的银奖。", "self", (0,)),
         FidelityCandidate("用户拿到了建筑模型比赛的银奖。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "auto",
                      "第 1 条虽由联系人发送，恭喜你明确指向用户获奖；第 2 条辅助回应。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "不能把发送者等同获奖者；subject=contact 与恭喜你的指向矛盾。")),
    ),
    FidelityCase(
        "subject-05", "subject",
        (("contact", "我同事跟我说，他养了一只名叫小满的橘猫。"),),
        (0,),
        (FidelityCandidate("联系人的同事养了一只名叫小满的橘猫。", "contact", (0,),
                           "report", "reported"),
         FidelityCandidate("联系人养了一只名叫小满的橘猫。", "contact", (0,),
                           "report", "reported")),
        (FidelityGold(0, "supported", (), "pending",
                      "第 1 条讲的是联系人的同事；contact 是关系资料范围，不是猫的主人。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "仅将同事改成联系人，改变养猫者；转述标签正确也不能掩盖人物错误。")),
    ),
    FidelityCase(
        "subject-06", "subject",
        (("self", "那台扫描仪是你买的吗？"),
         ("contact", "我妹妹跟我说那台扫描仪归她所有，现在我只帮她保管。")),
        (1,),
        (FidelityCandidate("联系人的妹妹拥有那台扫描仪。", "contact", (0, 1),
                           "report", "reported"),
         FidelityCandidate("联系人拥有那台扫描仪。", "contact", (0, 1),
                           "report", "reported")),
        (FidelityGold(0, "supported", (), "pending",
                      "第 2 条明确转述妹妹的所有权；本人保管状态只作上下文，不合入转述主张。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "仅改变所有者，把保管人联系人误作扫描仪所有者。")),
    ),
    FidelityCase(
        "subject-07", "subject",
        (("self", "你昨天结业的是哪门课？"),
         ("contact", "手冲咖啡，拿到结业证书了。")),
        (1,),
        (FidelityCandidate("联系人昨天完成了手冲咖啡课程并拿到结业证书。", "contact", (0, 1)),
         FidelityCandidate("用户昨天完成了手冲咖啡课程并拿到结业证书。", "contact", (0, 1))),
        (FidelityGold(0, "supported", (), "auto",
                      "第 1 条问联系人；第 2 条省略我但直接回答自己的课程与证书。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "仅改变正文中的结业者；省略回答不能把联系人事件转给提问用户。")),
    ),
    FidelityCase(
        "subject-08", "subject",
        (("contact", "你去年考的资格证现在用上了吗？"),
         ("self", "用上了，是花艺师证。")),
        (1,),
        (FidelityCandidate("用户去年取得的花艺师证现在已用上。", "self", (0, 1)),
         FidelityCandidate("联系人去年取得的花艺师证现在已用上。", "self", (0, 1))),
        (FidelityGold(0, "supported", (), "auto",
                      "第 1 条的你指用户，第 2 条由用户回答证书种类及已用上。"),
         FidelityGold(1, "unsupported", ("subject",), "none",
                      "仅改变正文人物，不能因联系人提出证书问题就把证书归给联系人。")),
    ),
    FidelityCase(
        "state-01", "state",
        (("contact", "我已经把新买的书架装好，放到书房了。"),),
        (0,),
        (FidelityCandidate("联系人已装好新买的书架，并放到书房。", "contact", (0,)),
         FidelityCandidate("联系人打算装好新买的书架，并放到书房。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "auto", "第 1 条的已经和了明确装好、放好都已完成。"),
         FidelityGold(1, "unsupported", ("pragmatics",), "none",
                      "只把完成状态改成打算；原话没有未来安装计划，已发生不能倒退为计划。")),
    ),
    FidelityCase(
        "state-02", "state",
        (("self", "你家路由器现在放在哪里？"),
         ("contact", "就在玄关柜里，昨天搬过去的。")),
        (1,),
        (FidelityCandidate("联系人的路由器当前放在玄关柜里，昨天已搬过去。", "contact", (0, 1)),
         FidelityCandidate("联系人的路由器打算放在玄关柜里，昨天已搬过去。", "contact", (0, 1))),
        (FidelityGold(0, "supported", (), "auto",
                      "第 2 条直接回答当前位置，并说明昨天搬移；第 1 条提供物品指向。"),
         FidelityGold(1, "unsupported", ("pragmatics",), "none",
                      "仅把当前摆放改成打算摆放；已经搬去的补充不能支持新增计划。")),
    ),
    FidelityCase(
        "state-03", "state",
        (("contact", "木版画套色我已经学会了。"),),
        (0,),
        (FidelityCandidate("联系人已经学会木版画套色。", "contact", (0,)),
         FidelityCandidate("联系人准备学习木版画套色。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "auto", "第 1 条陈述技能已经学会。"),
         FidelityGold(1, "unsupported", ("pragmatics",), "none",
                      "只改变掌握状态为未来学习意向；原话没有表达准备学习。")),
    ),
    FidelityCase(
        "state-04", "state",
        (("contact", "我们俩决定一起参加城市定向赛，现在还没参加。"),),
        (0,),
        (FidelityCandidate("双方决定一起参加城市定向赛，目前尚未参加。", "shared", (0,), "plan"),
         FidelityCandidate("双方已经一起参加了城市定向赛。", "shared", (0,), "plan")),
        (FidelityGold(0, "supported", (), "pending",
                      "第 1 条是双方未来参赛决定，并明确没有参加；plan 忠实但仍只能 pending。"),
         FidelityGold(1, "unsupported", ("pragmatics",), "none",
                      "仅把未来安排改为已完成；plan 标签不能挽救正文对事件阶段的反转。")),
    ),
    FidelityCase(
        "state-05", "state",
        (("self", "我已经取消了去海洋馆的安排。"),),
        (0,),
        (FidelityCandidate("用户已经取消了去海洋馆的安排。", "self", (0,)),
         FidelityCandidate("用户计划取消去海洋馆的安排。", "self", (0,))),
        (FidelityGold(0, "supported", (), "auto", "第 1 条描述已完成的取消行为，不是待实施安排。"),
         FidelityGold(1, "unsupported", ("pragmatics",), "none",
                      "仅把已经取消改成计划取消，错误保留尚未取消的含义。")),
    ),
    FidelityCase(
        "state-06", "state",
        (("contact", "我哥哥刚跟我说，他刚接到修复古籍的工作。"),),
        (0,),
        (FidelityCandidate("联系人的哥哥刚接到修复古籍的工作。", "contact", (0,), "report", "reported"),
         FidelityCandidate("联系人的哥哥刚接到修复古籍的工作。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "pending",
                      "第 1 条是联系人转述哥哥的事件；正文保留哥哥，report/reported 忠实。"),
         FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                      "正文有依据，但只有语用字段从第三方转述升级为 assertion/asserted，应降级。")),
    ),
    FidelityCase(
        "state-07", "state",
        (("contact", "我打算开始养蜂，目前还没开始。"),),
        (0,),
        (FidelityCandidate("联系人打算开始养蜂，目前尚未开始。", "contact", (0,), "plan"),
         FidelityCandidate("联系人打算开始养蜂，目前尚未开始。", "contact", (0,))),
        (FidelityGold(0, "supported", (), "pending", "第 1 条是未实施的打算；正文和 plan 标签一致。"),
         FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                      "正文没有改动，但仅 speech_act 改成 assertion，与明确未开始的计划矛盾。")),
    ),
    FidelityCase(
        "state-08", "state",
        (("self", "我姑姑跟我说，她现在在县里的植物园做导览。"),),
        (0,),
        (FidelityCandidate("用户的姑姑目前在县里的植物园做导览。", "self", (0,), "report", "reported"),
         FidelityCandidate("用户的姑姑目前在县里的植物园做导览。", "self", (0,), "report")),
        (FidelityGold(0, "supported", (), "pending",
                      "第 1 条是用户转述姑姑的当前工作；self 表示用户范围，正文仍是第三方。"),
         FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                      "正文及 report 未变，只将 assertion_status 从 reported 改成 asserted，丢失转述承诺状态。")),
    ),
)
