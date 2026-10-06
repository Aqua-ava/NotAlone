"""合成评测集的兼容入口；维度模块见 `cases/` 子包。

本模块保留原有导出名，`CASES` 的顺序与拆分前一致，便于既有评测与测试继续按原
方式导入。用例正文、期望与严格命题 oracle 都未改动，只把期望去向从字符串换成
领域枚举 `MemoryDisposition`。
"""

from __future__ import annotations

from dataclasses import replace

from .cases import CASES as _BASE_CASES
from .cases import ClaimExpectation, EvaluationCase, ExpectedDestination

__all__ = ["CASES", "ClaimExpectation", "EvaluationCase", "ExpectedDestination"]

# 严格命题 oracle：只给已经独立复核的场景补有限同义表述。
_STRICT_CLAIMS: dict[str, tuple[ClaimExpectation, ...]] = {
    "复核：夸张口号不等于偏好": (),
    "复核：短期方向不等于习惯": (),
    "保真：否定喝酒": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:不喝酒|不饮酒|滴酒不沾)[。]?",
    )),),
    "否定事实": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:不喝酒|不饮酒|滴酒不沾)[。]?",
    )),),
    "保真：否认借钱": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"(?:联系人)?(?:没借钱给他|没有借钱给他|未借钱给他)[，,](?:是他|对方)(?:记错了|记错)[。]?",
    )),),
    "保真：未定换工作": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:还没|尚未|还没有)决定(?:要不要|是否)换工作[。]?",
    )),),
    "保真：讨厌香菜": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:特别|非常|极其)讨厌(?:吃)?香菜(?:[，,](?:闻到|闻见)(?:就|都)难受)?[。]?",
        r"(?:联系人)?对香菜(?:极为|非常)反感(?:[，,](?:闻到|闻见)(?:就|都)难受)?[。]?",
    )),),
    "保真：条件爬山": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"(?:联系人)?如果下周不下雨[，,](?:就|才|会)去爬山[。]?",
        r"(?:联系人)?只有下周不下雨才去爬山[。]?",
    ), (("speech_act", "plan"), ("assertion_status", "conditional"))),),
    "保真：取消见面": (ClaimExpectation("shared", ExpectedDestination.AUTO, (
        r"(?:双方|我们)?(?:原本|原先|原定)(?:约的|约定的)?周六见面(?:的安排)?(?:已经|已)?取消(?:了)?[。]?",
    )),),
    "保真：只喝一点": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:平时)?只喝(?:一点|少量)酒(?:[，,](?:不会|不)多喝)?[。]?",
        r"(?:联系人)?(?:平时)?只(?:饮|饮用)少量酒(?:[，,](?:不会|不)多喝)?[。]?",
    )),),
    "保真：只有周日有空": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:只有|仅)周日有空[，,](?:其他|其余)(?:天|日子)(?:都)?(?:排满了|排满|没空)[。]?",
    )),),
    "指代：门票": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:已经|已)?(?:买好|买了|购得)(?:了)?(?:两|2)张门票[。]?",
    )),),
    "指代：那本书": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:刚|已经|已)?(?:看完|读完)(?:了)?《活着》[。]?",
        r"(?:联系人)?《活着》(?:刚|已经|已)?(?:看完|读完)(?:了)?[。]?",
    )),),
    "指代：机场等行李": (ClaimExpectation("contact", ExpectedDestination.AUTO, (
        r"(?:联系人)?(?:已经|已)?(?:到机场|抵达机场)(?:了)?[，,](?:正|正在)等行李[。]?",
    )),),
    "指代：跨消息老李": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"老李(?:约|邀请)联系人周末(?:去)?钓鱼[。]?",
        r"(?:据联系人说[，,])?老李周末(?:约|邀请)(?:他|联系人)(?:去)?钓鱼[。]?",
    ), (("assertion_status", "reported"),)),),
    "指代：面试结果": (
        ClaimExpectation("contact", ExpectedDestination.AUTO, (
            r"(?:联系人)?(?:已经|已)?(?:通过|通过了)面试[。]?",
        )),
        ClaimExpectation("contact", ExpectedDestination.PENDING, (
            r"(?:联系人)?下周一(?:计划|准备|将|要)?入职[。]?",
        ), (("speech_act", "plan"),), valid_at_iso="2026-09-21T00:00:00+00:00"),
    ),
    "第三方引用": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"(?:据联系人说[，,])?一名(?:身份不明的|不明身份的)第三人(?:说)?(?:要|计划|准备)贷款(?:30|三十)万[。]?",
    ), (("assertion_status", "reported"),)),),
    "明确转述": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"(?:据联系人转述[，,])?老李(?:说他|表示他|说)?下周(?:要|计划|准备)去上海出差[。]?",
    ), (("assertion_status", "reported"),)),),
    "无标记转述": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"联系人的(?:妈妈|母亲)(?:要求|让)联系人十一回家相亲[。]?",
    ), (("assertion_status", "reported"),)),),
    "转述领导评价": (ClaimExpectation("contact", ExpectedDestination.PENDING, (
        r"联系人的领导(?:认为|说|评价)联系人最近(?:进步很大|有很大进步)[。]?",
    ), (("assertion_status", "reported"),)),),
}

CASES = tuple(
    replace(case, expected_claims=_STRICT_CLAIMS[case.name])
    if case.name in _STRICT_CLAIMS else case
    for case in _BASE_CASES
)
