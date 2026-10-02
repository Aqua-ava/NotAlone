"""第二轮独立留出场景；来源与答案在模型调用前制定，不读取实验输出。"""

from notalone.memory_extraction.fidelity_cases import (
    FidelityCandidate,
    FidelityCase,
    FidelityGold,
    build_fidelity_window,
    candidate_payloads,
)

__all__ = [
    "FIDELITY_HOLDOUT_CASES",
    "build_fidelity_window",
    "candidate_payloads",
]


FIDELITY_HOLDOUT_CASES: tuple[FidelityCase, ...] = (
    FidelityCase(
        "holdout-subject-01", "subject",
        (("contact", "我们俩上周一起做完了社区的小型天气站。"),),
        (0,),
        (
            FidelityCandidate("双方上周一起完成了社区的小型天气站。", "shared", (0,)),
            FidelityCandidate("双方上周一起完成了社区的小型天气站。", "contact", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条明确我们俩一起完成，是双方共同经历。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变 subject；contact 把明确共同经历标为联系人单方。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-02", "subject",
        (("contact", "那篇访谈是我独自翻译完的，没有其他人参与。"),),
        (0,),
        (
            FidelityCandidate("联系人独自完成了那篇访谈的翻译，没有其他人参与。", "contact", (0,)),
            FidelityCandidate("联系人独自完成了那篇访谈的翻译，没有其他人参与。", "shared", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条联系人明确自述独自完成，且排除其他人参与。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变 subject；shared 与明确单方完成矛盾。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-03", "subject",
        (("contact", "你亲手做的那张木雕面具在市集卖出去了。"),),
        (0,),
        (
            FidelityCandidate("用户亲手做的木雕面具已在市集卖出。", "self", (0,)),
            FidelityCandidate("用户亲手做的木雕面具已在市集卖出。", "contact", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条由联系人描述你亲手做的作品，你指用户，事件已发生。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变 subject；联系人说出用户事件，不使它成为联系人事件。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-04", "subject",
        (("self", "你负责的小区无障碍坡道已经验收了。"),),
        (0,),
        (
            FidelityCandidate("联系人负责的小区无障碍坡道已经验收。", "contact", (0,)),
            FidelityCandidate("联系人负责的小区无障碍坡道已经验收。", "self", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条由用户描述你的项目，你指联系人；发送者不是项目负责人。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变 subject；self 把联系人的项目归入用户本人。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-05", "subject",
        (("self", "我的邻居告诉我，他是夜班公交车司机。"),),
        (0,),
        (
            FidelityCandidate("用户的邻居是夜班公交车司机。", "self", (0,), "report", "reported"),
            FidelityCandidate("用户是夜班公交车司机。", "self", (0,), "report", "reported"),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条用户转述邻居的职业；self 是用户资料范围，正文人物仍是邻居。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变正文的任职者，把邻居职业改为用户职业。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-06", "subject",
        (("contact", "我的前室友告诉我，他现在是调琴师。"),),
        (0,),
        (
            FidelityCandidate("联系人的前室友现在是调琴师。", "contact", (0,), "report", "reported"),
            FidelityCandidate("联系人现在是调琴师。", "contact", (0,), "report", "reported"),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条明确来自前室友告知；contact 是关系资料范围，正文人物是前室友。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变正文职业主体，把前室友的事改成联系人的事。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-07", "subject",
        (("contact", "那台切割机是你的，我只是在借用。"),),
        (0,),
        (
            FidelityCandidate("那台切割机属于用户，联系人只是借用。", "self", (0,)),
            FidelityCandidate("那台切割机属于联系人，联系人只是借用。", "self", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条联系人明确说是你的，所有者是用户，我借用只说明联系人使用。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变正文所有者；借用人的身份不能代替原文明确的用户所有权。"),
        ),
    ),
    FidelityCase(
        "holdout-subject-08", "subject",
        (("self", "你创办的兴趣小组叫什么？"),
         ("contact", "星航，去年正式成立的。")),
        (1,),
        (
            FidelityCandidate("联系人创办的兴趣小组名为星航，去年正式成立。", "contact", (0, 1)),
            FidelityCandidate("用户创办的兴趣小组名为星航，去年正式成立。", "contact", (0, 1)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条问联系人创办的小组，第 2 条省略主语回答名称与成立期间。"),
            FidelityGold(1, "unsupported", ("subject",), "none",
                         "只改变正文创办者；联系人回答自己的小组，不能归给提问用户。"),
        ),
    ),
    FidelityCase(
        "holdout-state-01", "state",
        (("contact", "我已经把收集的贝壳做成风铃了。"),),
        (0,),
        (
            FidelityCandidate("联系人已经把收集的贝壳做成风铃。", "contact", (0,)),
            FidelityCandidate("联系人打算把收集的贝壳做成风铃。", "contact", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条已经做成了明确完成制作；收集的材料与完成产物都保留。"),
            FidelityGold(1, "unsupported", ("pragmatics",), "none",
                         "只改变正文制作阶段，把完成制作改成尚待实施的打算。"),
        ),
    ),
    FidelityCase(
        "holdout-state-02", "state",
        (("self", "你的无人机现在收在哪里？"),
         ("contact", "在储藏室的防潮箱里。")),
        (1,),
        (
            FidelityCandidate("联系人的无人机目前收在储藏室的防潮箱里。", "contact", (0, 1)),
            FidelityCandidate("联系人的无人机准备收在储藏室的防潮箱里。", "contact", (0, 1)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条问现在的位置，第 2 条直接回答现有存放位置，不是拟定位置。"),
            FidelityGold(1, "unsupported", ("pragmatics",), "none",
                         "只改变正文状态，把已在该处收存改成未来准备收存。"),
        ),
    ),
    FidelityCase(
        "holdout-state-03", "state",
        (("contact", "我准备加入气象观测志愿队，目前尚未加入。"),),
        (0,),
        (
            FidelityCandidate("联系人准备加入气象观测志愿队，目前尚未加入。", "contact", (0,), "plan"),
            FidelityCandidate("联系人已经加入气象观测志愿队。", "contact", (0,), "plan"),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条是明确未实施的加入意向；plan 忠实，尚未发生仍 pending。"),
            FidelityGold(1, "unsupported", ("pragmatics",), "none",
                         "只改变正文阶段，原文明确尚未加入，不能改成已经加入。"),
        ),
    ),
    FidelityCase(
        "holdout-state-04", "state",
        (("self", "我已经撤销了手工香皂课程的报名。"),),
        (0,),
        (
            FidelityCandidate("用户已经撤销了手工香皂课程的报名。", "self", (0,)),
            FidelityCandidate("用户计划撤销手工香皂课程的报名。", "self", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条描述报名已被撤销，这是完成的取消行为。"),
            FidelityGold(1, "unsupported", ("pragmatics",), "none",
                         "只改变正文取消阶段，不能把已撤销写成尚待撤销的计划。"),
        ),
    ),
    FidelityCase(
        "holdout-state-05", "state",
        (("contact", "我们俩已经排完双人默剧的第一幕了。"),),
        (0,),
        (
            FidelityCandidate("双方已经排完双人默剧的第一幕。", "shared", (0,)),
            FidelityCandidate("双方打算排完双人默剧的第一幕。", "shared", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "auto",
                         "第 1 条明确共同排完第一幕，主体与完成阶段均直接支持。"),
            FidelityGold(1, "unsupported", ("pragmatics",), "none",
                         "只改变正文完成阶段；shared 正确也不能挽救新增未来打算。"),
        ),
    ),
    FidelityCase(
        "holdout-state-06", "state",
        (("contact", "我姐姐告诉我，她已经把一批玻璃底片捐给地方档案馆了。"),),
        (0,),
        (
            FidelityCandidate("联系人的姐姐已把一批玻璃底片捐给地方档案馆。", "contact", (0,), "report", "reported"),
            FidelityCandidate("联系人的姐姐已把一批玻璃底片捐给地方档案馆。", "contact", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条明确姐姐告诉联系人，是完成捐赠的第三方转述，不是联系人的亲历。"),
            FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                         "正文忠实，只把 report/reported 升为 assertion/asserted；沿契约降为 uncertain。"),
        ),
    ),
    FidelityCase(
        "holdout-state-07", "state",
        (("self", "我舅舅说，他每周都会去河边记录水鸟。"),),
        (0,),
        (
            FidelityCandidate("用户的舅舅每周都会去河边记录水鸟。", "self", (0,), "report", "reported"),
            FidelityCandidate("用户的舅舅每周都会去河边记录水鸟。", "self", (0,), "report"),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条舅舅说明确转述来源；每周是第三方习惯，report/reported 均应保留。"),
            FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                         "正文及 report 不变，只把 reported 改成 asserted，丢失第三方转述状态。"),
        ),
    ),
    FidelityCase(
        "holdout-state-08", "state",
        (("contact", "我准备学习木偶操控，目前还没开始。"),),
        (0,),
        (
            FidelityCandidate("联系人准备学习木偶操控，目前尚未开始。", "contact", (0,), "plan"),
            FidelityCandidate("联系人准备学习木偶操控，目前尚未开始。", "contact", (0,)),
        ),
        (
            FidelityGold(0, "supported", (), "pending",
                         "第 1 条明确尚未开始的学习意向，用 plan 保留，不能自动采纳。"),
            FidelityGold(1, "uncertain", ("pragmatics",), "pending",
                         "正文不变，只将 speech_act 从 plan 改成 assertion；标签错误按契约 uncertain。"),
        ),
    ),
)
