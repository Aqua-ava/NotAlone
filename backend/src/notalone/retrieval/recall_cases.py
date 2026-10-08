"""合成中文记忆召回评测用例。

全部为合成内容，不包含真实聊天、联系人资料或模型输出。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


DIMENSION_DIRECT = "direct"
DIMENSION_PARAPHRASE = "paraphrase"
DIMENSION_IRRELEVANT = "irrelevant"
DIMENSION_ISOLATION = "isolation"
DIMENSION_INVALID = "invalid"
DIMENSION_BUDGET = "budget"
DIMENSION_ORDERING = "ordering"

DIMENSIONS = (
    DIMENSION_DIRECT,
    DIMENSION_PARAPHRASE,
    DIMENSION_IRRELEVANT,
    DIMENSION_ISOLATION,
    DIMENSION_INVALID,
    DIMENSION_BUDGET,
    DIMENSION_ORDERING,
)

MIN_CASES_PER_DIMENSION = 15

_EXPIRED_VALID_AT = datetime(2020, 1, 1, tzinfo=timezone.utc)
_EXPIRED_INVALID_AT = datetime(2020, 1, 2, tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class RecallMemoryCase:
    """一条合成记忆及其检索状态。"""

    text: str
    adoption_method: str = "auto"
    confidence: float = 1.0
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    state: str = "active"
    category: str = "preference"
    topic: str = "other"
    contact: str = "primary"


@dataclass(frozen=True, slots=True)
class RecallCase:
    """一条召回评测用例。"""

    name: str
    dimension: str
    query: str
    memories: tuple[RecallMemoryCase, ...] = ()
    owner_memories: tuple[RecallMemoryCase, ...] = ()
    expect_recalled: tuple[str, ...] = ()
    expect_order: tuple[str, ...] = ()


def _memory(
    text: str,
    *,
    confidence: float = 1.0,
    adoption_method: str = "auto",
    valid_at: datetime | None = None,
    invalid_at: datetime | None = None,
    state: str = "active",
    contact: str = "primary",
) -> RecallMemoryCase:
    return RecallMemoryCase(
        text=text,
        adoption_method=adoption_method,
        confidence=confidence,
        valid_at=valid_at,
        invalid_at=invalid_at,
        state=state,
        contact=contact,
    )


def _expired(text: str) -> RecallMemoryCase:
    return _memory(
        text,
        state="expired",
        valid_at=_EXPIRED_VALID_AT,
        invalid_at=_EXPIRED_INVALID_AT,
    )


def _invalidated(text: str) -> RecallMemoryCase:
    return _memory(text, state="invalidated")


def _deleted(text: str) -> RecallMemoryCase:
    return _memory(text, state="deleted")


def _single_memory_cases(
    prefix: str,
    dimension: str,
    pairs: tuple[tuple[str, str], ...],
) -> tuple[RecallCase, ...]:
    return tuple(
        RecallCase(
            name=f"{prefix} {index + 1}",
            dimension=dimension,
            query=query,
            memories=(_memory(memory),),
            expect_recalled=(
                (memory,) if dimension != DIMENSION_IRRELEVANT else ()
            ),
        )
        for index, (query, memory) in enumerate(pairs)
    )


def _isolation_cases(
    pairs: tuple[tuple[str, str, str], ...],
) -> tuple[RecallCase, ...]:
    return tuple(
        RecallCase(
            name=f"隔离 {index + 1}",
            dimension=DIMENSION_ISOLATION,
            query=query,
            memories=(
                _memory(primary),
                _memory(other, contact="other"),
            ),
            expect_recalled=(primary,),
        )
        for index, (query, primary, other) in enumerate(pairs)
    )


def _invalid_cases(
    triples: tuple[tuple[str, str, RecallMemoryCase], ...],
) -> tuple[RecallCase, ...]:
    return tuple(
        RecallCase(
            name=f"失效 {index + 1}",
            dimension=DIMENSION_INVALID,
            query=query,
            memories=(_memory(active), excluded),
            expect_recalled=(active,),
        )
        for index, (query, active, excluded) in enumerate(triples)
    )


def _owner_invalid_cases(
    triples: tuple[tuple[str, RecallMemoryCase, RecallMemoryCase], ...],
) -> tuple[RecallCase, ...]:
    return tuple(
        RecallCase(
            name=f"失效本人 {index + 1}",
            dimension=DIMENSION_INVALID,
            query=query,
            owner_memories=(active, excluded),
            expect_recalled=(active.text,),
        )
        for index, (query, active, excluded) in enumerate(triples)
    )


_DIRECT_PAIRS = (
    ("明天一起吃饭吗？", "对方明天有空"),
    ("周末去徒步吗？", "对方喜欢周末徒步"),
    ("他最近加班很多", "对方最近总加班"),
    ("项目进展怎么样", "对方项目进展顺利"),
    ("阿姨身体好些了吗", "对方阿姨身体恢复中"),
    ("他什么时候回北京", "对方下周回北京"),
    ("咖啡还是茶", "对方喜欢喝咖啡"),
    ("猫咪还好吗", "对方家里猫咪生病了"),
    ("上次说的贷款", "对方在办贷款手续"),
    ("考试准备得怎么样", "对方考试复习很紧张"),
    ("房子看得如何", "对方在看房子"),
    ("周末爬山吗", "对方周末想去爬山"),
    ("妈妈生日送什么", "对方妈妈生日快到了"),
    ("他的腰伤好了吗", "对方腰伤还在恢复"),
    ("出差几天", "对方去上海出差三天"),
)

_PARAPHRASE_PAIRS = (
    ("他是不是最近很忙？", "对方最近项目很多"),
    ("明天要下雨吗？", "天气预报说明天有雨"),
    ("他喜欢猫吗？", "联系人家里养了一只猫"),
    ("周末有什么安排？", "对方打算周末去爬山"),
    ("阿姨身体恢复了吗？", "对方阿姨刚出院"),
    ("他最近工作压力大吗？", "对方最近经常加班"),
    ("房子的事怎么样了？", "对方最近在看房子"),
    ("咖啡店的约会定了吗？", "对方约我周末喝咖啡"),
    ("贷款办下来了吗？", "对方贷款还在审批"),
    ("考试复习得如何？", "对方快考试了很紧张"),
    ("妈妈的生日准备了吗？", "对方准备了妈妈生日礼物"),
    ("他腰伤恢复得怎样？", "对方腰伤最近好多了"),
    ("猫咪生病好点没？", "对方带猫咪去看医生了"),
    ("出差顺利吗？", "对方上海出差一切顺利"),
    ("他什么时候搬新家？", "对方下个月搬新家"),
)

_IRRELEVANT_PAIRS = (
    ("谢谢啦", "对方喜欢徒步"),
    ("在吗", "他最近换了工作"),
    ("哈哈哈哈", "周末一起爬山"),
    ("好的没问题", "对方养了一只猫"),
    ("晚安", "他明天去北京"),
    ("嗯嗯", "对方在准备考试"),
    ("收到", "她妈妈生日在五月"),
    ("稍等", "对方喜欢喝咖啡"),
    ("辛苦了", "我下周出差"),
    ("一会聊", "对方在办贷款"),
    ("没事", "他腰伤恢复了"),
    ("明天见", "对方项目很顺利"),
    ("拍照看看", "他最近心情不错"),
    ("你也是", "对方周末要搬家"),
    ("冲鸭", "他家的猫生病了"),
)

_ISOLATION_TRIPLES = (
    ("周末一起去徒步吗？", "对方喜欢周末徒步", "我们周末经常徒步"),
    ("明天一起吃饭吗？", "对方明天有空", "他明天想约饭"),
    ("他最近加班多吗", "对方最近总加班", "同事最近天天加班"),
    ("项目进展如何", "对方项目进展顺利", "项目进展遇到问题"),
    ("阿姨身体怎么样", "对方阿姨身体恢复中", "阿姨身体需要复查"),
    ("什么时候回北京", "对方下周回北京", "我下月回北京"),
    ("他喜欢咖啡吗", "对方喜欢喝咖啡", "喜欢喝咖啡的人"),
    ("猫咪还好吗", "对方家里猫咪生病了", "猫咪最近很健康"),
    ("贷款办好了吗", "对方在办贷款手续", "贷款需要担保人"),
    ("考试准备如何", "对方考试复习很紧张", "考试快到了"),
    ("房子看得如何", "对方在看房子", "房子涨价了"),
    ("周末去爬山吗", "对方周末想去爬山", "周末爬山要早起"),
    ("妈妈生日送什么", "对方妈妈生日快到了", "妈妈生日礼物已买"),
    ("腰伤好了吗", "对方腰伤还在恢复", "腰伤要紧吗"),
    ("出差几天", "对方去上海出差三天", "出差要带电脑"),
)

_OWNER_INVALID_TRIPLES = (
    (
        "明天一起吃饭吗？",
        RecallMemoryCase(text="我明天有空", adoption_method="manual"),
        _expired("我明天没空"),
    ),
    (
        "周末一起去徒步吗？",
        RecallMemoryCase(text="我周末有空", adoption_method="manual"),
        _invalidated("我周末没空"),
    ),
    (
        "周末去徒步怎么样？",
        RecallMemoryCase(text="我周末想出门", adoption_method="manual"),
        _deleted("我周末不想出门"),
    ),
)

_INVALID_TRIPLES = (
    ("周末一起去徒步吗？", "对方喜欢周末徒步", _expired("对方讨厌徒步")),
    ("明天一起吃饭吗？", "对方明天有空", _invalidated("对方明天没空")),
    ("他最近加班多吗", "对方最近总加班", _deleted("对方从不加班")),
    ("项目进展如何", "对方项目进展顺利", _invalidated("项目已经暂停")),
    ("阿姨身体怎么样", "对方阿姨身体恢复中", _expired("阿姨已经出院")),
    ("什么时候回北京", "对方下周回北京", _deleted("他上月回北京")),
    ("他喜欢咖啡吗", "对方喜欢喝咖啡", _invalidated("对方戒了咖啡")),
    ("猫咪还好吗", "对方家里猫咪生病了", _expired("猫咪已经康复")),
    ("贷款办好了吗", "对方在办贷款手续", _invalidated("贷款被拒了")),
    ("考试准备如何", "对方考试复习很紧张", _deleted("考试已经结束")),
    ("房子看得如何", "对方在看房子", _expired("房子已经买了")),
    ("周末去爬山吗", "对方周末想去爬山", _invalidated("爬山计划取消了")),
    ("妈妈生日送什么", "对方妈妈生日快到了", _deleted("生日已经过了")),
    ("腰伤好了吗", "对方腰伤还在恢复", _expired("腰伤完全好了")),
    ("出差几天", "对方去上海出差三天", _invalidated("出差取消了")),
)

_BUDGET_COUNT_TEXTS = (
    "对方周末喜欢徒步",
    "他的周末总是徒步",
    "周末安排就是徒步",
    "周末和徒步最舒服",
    "周末徒步让人开心",
    "我爱周末也爱徒步",
    "周末徒步呼吸新鲜",
)

_BUDGET_COUNT_CONFIDENCES = (0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65)

_BUDGET_CHAR_TEXTS = tuple(
    f"周末徒步{'呀' * 146}"
    for _ in range(5)
)
_BUDGET_CHAR_CONFIDENCES = (0.9, 0.8, 0.7, 0.6, 0.5)

_OWNER_TEXTS = (
    "我明天有空",
    "我明天休息",
    "我明天可以晚点",
    "我明天想出门",
)
_OWNER_CONFIDENCES = (0.9, 0.8, 0.7, 0.6)

_OWNER_CHAR_TEXTS = tuple(f"我明天有空{'好' * 95}" for _ in range(3))
_OWNER_CHAR_CONFIDENCES = (0.9, 0.8, 0.7)


def _budget_cases() -> tuple[RecallCase, ...]:
    cases = []
    count_memories = tuple(
        _memory(text, confidence=confidence)
        for text, confidence in zip(
            _BUDGET_COUNT_TEXTS,
            _BUDGET_COUNT_CONFIDENCES,
        )
    )
    cases.append(
        RecallCase(
            name="预算 1",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=count_memories,
            expect_recalled=_BUDGET_COUNT_TEXTS[:5],
        )
    )
    cases.append(
        RecallCase(
            name="预算 2",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=count_memories[1:],
            expect_recalled=_BUDGET_COUNT_TEXTS[1:6],
        )
    )
    cases.append(
        RecallCase(
            name="预算 3",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=count_memories[2:],
            expect_recalled=_BUDGET_COUNT_TEXTS[2:7],
        )
    )
    cases.append(
        RecallCase(
            name="预算 4",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=count_memories[:3],
            expect_recalled=_BUDGET_COUNT_TEXTS[:3],
        )
    )
    cases.append(
        RecallCase(
            name="预算 5",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=(count_memories[3],),
            expect_recalled=(_BUDGET_COUNT_TEXTS[3],),
        )
    )
    char_memories = tuple(
        _memory(text, confidence=confidence)
        for text, confidence in zip(
            _BUDGET_CHAR_TEXTS,
            _BUDGET_CHAR_CONFIDENCES,
        )
    )
    cases.append(
        RecallCase(
            name="预算 6",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=char_memories,
            expect_recalled=_BUDGET_CHAR_TEXTS[:4],
        )
    )
    cases.append(
        RecallCase(
            name="预算 7",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=char_memories[:3],
            expect_recalled=_BUDGET_CHAR_TEXTS[:3],
        )
    )
    cases.append(
        RecallCase(
            name="预算 8",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=char_memories[:2],
            expect_recalled=_BUDGET_CHAR_TEXTS[:2],
        )
    )
    owner_memories = tuple(
        RecallMemoryCase(
            text=text,
            confidence=confidence,
            adoption_method="manual",
        )
        for text, confidence in zip(_OWNER_TEXTS, _OWNER_CONFIDENCES)
    )
    cases.append(
        RecallCase(
            name="预算 9",
            dimension=DIMENSION_BUDGET,
            query="明天一起吃饭吗？",
            owner_memories=owner_memories,
            expect_recalled=_OWNER_TEXTS[:3],
        )
    )
    cases.append(
        RecallCase(
            name="预算 10",
            dimension=DIMENSION_BUDGET,
            query="明天一起吃饭吗？",
            owner_memories=owner_memories[:3],
            expect_recalled=_OWNER_TEXTS[:3],
        )
    )
    owner_char_memories = tuple(
        RecallMemoryCase(
            text=text,
            confidence=confidence,
            adoption_method="manual",
        )
        for text, confidence in zip(
            _OWNER_CHAR_TEXTS,
            _OWNER_CHAR_CONFIDENCES,
        )
    )
    cases.append(
        RecallCase(
            name="预算 11",
            dimension=DIMENSION_BUDGET,
            query="明天一起吃饭吗？",
            owner_memories=owner_char_memories,
            expect_recalled=_OWNER_CHAR_TEXTS[:2],
        )
    )
    cases.append(
        RecallCase(
            name="预算 12",
            dimension=DIMENSION_BUDGET,
            query="明天一起吃饭吗？",
            owner_memories=owner_char_memories[1:],
            expect_recalled=_OWNER_CHAR_TEXTS[1:],
        )
    )
    independence_contacts = tuple(
        _memory(text, confidence=confidence)
        for text, confidence in zip(
            _BUDGET_COUNT_TEXTS[:6],
            _BUDGET_COUNT_CONFIDENCES[:6],
        )
    )
    independence_owners = tuple(
        RecallMemoryCase(
            text=text,
            confidence=confidence,
            adoption_method="manual",
        )
        for text, confidence in zip(_OWNER_TEXTS, _OWNER_CONFIDENCES)
    )
    weekend_owner_texts = (
        "我周末有空",
        "我周末休息",
        "我周末可以晚点",
        "我周末想吃火锅",
    )
    weekend_owner_memories = tuple(
        RecallMemoryCase(
            text=text,
            confidence=confidence,
            adoption_method="manual",
        )
        for text, confidence in zip(
            weekend_owner_texts,
            _OWNER_CONFIDENCES,
        )
    )
    independence_variants = (
        (
            "周末一起去徒步吗？",
            weekend_owner_memories,
            weekend_owner_texts,
        ),
        (
            "周末去徒步怎么样？",
            weekend_owner_memories,
            weekend_owner_texts,
        ),
        (
            "这周末一起去徒步吧？",
            weekend_owner_memories,
            weekend_owner_texts,
        ),
    )
    for index, (case_query, owners, expected_owner_texts) in enumerate(
        independence_variants
    ):
        cases.append(
            RecallCase(
                name=f"预算 {13 + index}",
                dimension=DIMENSION_BUDGET,
                query=case_query,
                memories=independence_contacts,
                owner_memories=owners,
                expect_recalled=(
                    *_BUDGET_COUNT_TEXTS[:5],
                    *expected_owner_texts[:3],
                ),
            )
        )
    cases.append(
        RecallCase(
            name="预算 16",
            dimension=DIMENSION_BUDGET,
            query="周末一起去徒步吗？",
            memories=tuple(
                _memory(text, confidence=confidence)
                for text, confidence in zip(
                    _BUDGET_CHAR_TEXTS,
                    _BUDGET_CHAR_CONFIDENCES,
                )
            ),
            owner_memories=weekend_owner_memories,
            expect_recalled=(
                *_BUDGET_CHAR_TEXTS[:4],
                *weekend_owner_texts[:3],
            ),
        )
    )
    return tuple(cases)


def _ordering_cases() -> tuple[RecallCase, ...]:
    hiking = "对方喜欢徒步"
    climbing = "对方喜欢爬山"
    query = "周末去徒步还是爬山？"
    older = datetime(2026, 1, 1, tzinfo=timezone.utc)
    newer = datetime(2026, 6, 1, tzinfo=timezone.utc)
    cases = []

    cases.append(
        RecallCase(
            name="排序 1",
            dimension=DIMENSION_ORDERING,
            query="周末一起去徒步吗？",
            memories=(
                _memory("对方喜欢徒步"),
                _memory("对方周末喜欢徒步"),
            ),
            expect_order=("对方周末喜欢徒步", "对方喜欢徒步"),
        )
    )
    cases.append(
        RecallCase(
            name="排序 2",
            dimension=DIMENSION_ORDERING,
            query="周末一起去徒步吗？",
            memories=(
                _memory("对方喜欢徒步"),
                _memory("对方周末喜欢徒步"),
                _memory("对方周末喜欢去徒步"),
            ),
            expect_order=(
                "对方周末喜欢去徒步",
                "对方周末喜欢徒步",
                "对方喜欢徒步",
            ),
        )
    )
    cases.append(
        RecallCase(
            name="排序 3",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(climbing, confidence=0.8),
                _memory(hiking, confidence=0.8, adoption_method="manual"),
            ),
            expect_order=(hiking, climbing),
        )
    )
    cases.append(
        RecallCase(
            name="排序 4",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(climbing, confidence=0.95),
                _memory(hiking, confidence=0.5, adoption_method="manual"),
            ),
            expect_order=(hiking, climbing),
        )
    )
    cases.append(
        RecallCase(
            name="排序 5",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(climbing, confidence=0.5, valid_at=newer),
                _memory(hiking, confidence=0.5, adoption_method="manual"),
            ),
            expect_order=(hiking, climbing),
        )
    )
    cases.append(
        RecallCase(
            name="排序 6",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, confidence=0.6),
                _memory(climbing, confidence=0.9),
            ),
            expect_order=(climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 7",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, confidence=0.3),
                _memory(climbing, confidence=0.4),
            ),
            expect_order=(climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 8",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, confidence=0.99),
                _memory(climbing, confidence=1.0),
            ),
            expect_order=(climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 9",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, valid_at=older),
                _memory(climbing, valid_at=newer),
            ),
            expect_order=(climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 10",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, valid_at=newer),
                _memory(climbing),
            ),
            expect_order=(hiking, climbing),
        )
    )
    cases.append(
        RecallCase(
            name="排序 11",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                RecallMemoryCase(
                    text=hiking,
                    confidence=0.7,
                    valid_at=newer,
                ),
                RecallMemoryCase(
                    text=climbing,
                    confidence=0.9,
                    valid_at=older,
                ),
            ),
            expect_order=(climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 12",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking),
                _memory("对方周末喜欢去徒步"),
            ),
            expect_order=("对方周末喜欢去徒步", hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 13",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(hiking, confidence=0.95, adoption_method="auto"),
                _memory(climbing, confidence=0.5, adoption_method="manual"),
                _memory("对方周末喜欢去徒步", confidence=0.6),
            ),
            expect_order=("对方周末喜欢去徒步", climbing, hiking),
        )
    )
    cases.append(
        RecallCase(
            name="排序 14",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                _memory(climbing, valid_at=older),
                _memory(hiking, valid_at=newer),
            ),
            expect_order=(hiking, climbing),
        )
    )
    cases.append(
        RecallCase(
            name="排序 15",
            dimension=DIMENSION_ORDERING,
            query=query,
            memories=(
                RecallMemoryCase(text=hiking, confidence=0.8, valid_at=older),
                RecallMemoryCase(
                    text=climbing,
                    confidence=0.8,
                    valid_at=newer,
                ),
                RecallMemoryCase(
                    text="对方周末喜欢去徒步",
                    confidence=0.8,
                    valid_at=newer,
                ),
            ),
            expect_order=(
                "对方周末喜欢去徒步",
                climbing,
                hiking,
            ),
        )
    )
    return tuple(cases)


CASES: tuple[RecallCase, ...] = (
    *_single_memory_cases("直述", DIMENSION_DIRECT, _DIRECT_PAIRS),
    *_single_memory_cases("改写", DIMENSION_PARAPHRASE, _PARAPHRASE_PAIRS),
    *_single_memory_cases("无关", DIMENSION_IRRELEVANT, _IRRELEVANT_PAIRS),
    *_isolation_cases(_ISOLATION_TRIPLES),
    *_invalid_cases(_INVALID_TRIPLES),
    *_owner_invalid_cases(_OWNER_INVALID_TRIPLES),
    *_budget_cases(),
    *_ordering_cases(),
)
