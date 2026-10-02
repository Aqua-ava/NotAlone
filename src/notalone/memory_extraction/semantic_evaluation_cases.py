"""严格合成命题与受控候选挑战；错误候选是预置输入，不代表自然提取错误率。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from notalone.memory_extraction.evaluation_cases import ClaimExpectation, EvaluationCase
from notalone.memory_extraction.models import ExtractionWindow
from notalone.memory_extraction.runtime import ExtractionPayload


@dataclass(frozen=True, slots=True)
class CandidateVariant:
    """一条受控候选；来源使用本场景窗口内的零起始序号。"""

    text: str
    subject: str = "contact"
    source_indices: tuple[int, ...] = (0,)
    speech_act: str = "assertion"
    assertion_status: str = "asserted"
    valid_at_iso: str | None = None
    invalid_at_iso: str | None = None


@dataclass(frozen=True, slots=True)
class CandidateChallenge:
    case: EvaluationCase
    good: tuple[CandidateVariant, ...]
    bad: tuple[CandidateVariant, ...]
    split: str = "development"


def challenge_payloads(
    challenge: CandidateChallenge, window: ExtractionWindow,
    *, variant: Literal["good", "bad"],
) -> ExtractionPayload:
    """把受控候选映射到当前合成窗口的实际 UUID，供同一公开链路配对核验。"""
    if variant not in ("good", "bad"):
        raise ValueError("挑战候选必须选择 good 或 bad。")
    candidates = challenge.good if variant == "good" else challenge.bad
    return tuple({
        "text": candidate.text, "category": "preference", "subject": candidate.subject,
        "topic": "other",
        "source_message_ids": [str(window.messages[index].message_id)
                               for index in candidate.source_indices],
        "confidence": 0.95, "risk_flags": [],
        "valid_at": candidate.valid_at_iso, "invalid_at": candidate.invalid_at_iso,
        "speech_act": candidate.speech_act, "assertion_status": candidate.assertion_status,
        "figurative_type": "literal", "alternatives": [],
        "interpretation_reason": "合成受控候选，语义支持需由独立核验判断。",
    } for candidate in candidates)


SEMANTIC_CHALLENGES: tuple[CandidateChallenge, ...] = (
    CandidateChallenge(
        EvaluationCase("严格：否定饮酒", "paraphrase",
            (("contact", "我不喝酒，你们喝就行。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("contact", "auto",
                (r"(?:联系人)?(?:不喝酒|不饮酒|滴酒不沾)[。]?",)),)),
        (CandidateVariant("联系人不喝酒。"),),
        (CandidateVariant("联系人每天喝半斤白酒。"),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：否定牛奶", "paraphrase",
            (("contact", "我从来不喝牛奶，早餐喝豆浆。"),), (0,), "auto",
            expected_claims=(
                ClaimExpectation("contact", "auto",
                    (
                        r"(?:联系人)?(?:从来不喝|从不喝|从不饮用)牛奶[。]?",
                        r"(?:联系人)?(?:从来不喝|从不喝|从不饮用)牛奶[，,](?:早餐|早饭)(?:喝|饮用)豆浆[。]?",
                    )),
                ClaimExpectation("contact", "auto",
                    (
                        r"(?:联系人)?(?:早餐|早饭)(?:喝|饮用)豆浆[。]?",
                        r"(?:联系人)?(?:从来不喝|从不喝|从不饮用)牛奶[，,](?:早餐|早饭)(?:喝|饮用)豆浆[。]?",
                    )),)),
        (CandidateVariant("联系人从不饮用牛奶。"), CandidateVariant("联系人早餐喝豆浆。")),
        (CandidateVariant("联系人早餐喜欢喝牛奶。"),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：偶尔徒步", "paraphrase",
            (("contact", "我偶尔去徒步，并不是每周都去。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("contact", "auto",
                (r"(?:联系人)?(?:偶尔|有时|不定期)(?:去)?徒步(?:，(?:不是|并非)每周都去)?[。]?",)),)),
        (CandidateVariant("联系人偶尔去徒步。"),),
        (CandidateVariant("联系人每周都去徒步。"),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：养猫数量", "quantity",
            (("contact", "我家养了两只猫，没有养狗。"),), (0,), "auto",
            expected_claims=(
                ClaimExpectation("contact", "auto",
                    (
                        r"(?:联系人)?(?:家里|家中|家)?(?:养了|养着|有)(?:两|2)只猫[。]?",
                        r"(?:联系人)?(?:家里|家中|家)?(?:养了|养着|有)(?:两|2)只猫[，,](?:没有养狗|没养狗|不养狗)[。]?",
                    )),
                ClaimExpectation("contact", "auto",
                    (
                        r"(?:联系人)?(?:没有养狗|没养狗|不养狗)[。]?",
                        r"(?:联系人)?(?:家里|家中|家)?(?:养了|养着|有)(?:两|2)只猫[，,](?:没有养狗|没养狗|不养狗)[。]?",
                    )),)),
        (CandidateVariant("联系人养了两只猫。"), CandidateVariant("联系人没有养狗。")),
        (CandidateVariant("联系人养了三只猫。"), CandidateVariant("联系人没有养狗。")),
    ),
    CandidateChallenge(
        EvaluationCase("严格：门票省略数量", "reference",
            (("self", "展览门票买好了吗？"), ("contact", "买好了，两张。")), (1,), "auto",
            expected_claims=(ClaimExpectation("contact", "auto",
                (r"(?:联系人)?(?:已经|已)?(?:买好|买了|购得)(?:了)?(?:两|2)张展览门票[。]?",)),)),
        (CandidateVariant("联系人已买好两张展览门票。", source_indices=(0, 1)),),
        (CandidateVariant("联系人已买好三张展览门票。", source_indices=(0, 1)),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：降雨前提", "condition",
            (("contact", "明天要是不降雨，我才去露营。"),), (0,), "pending",
            expected_claims=(ClaimExpectation("contact", "pending", (
                r"(?:联系人)?(?:明天不降雨才|只有明天不下雨才|如果明天不降雨就)(?:去|会去)露营[。]?",
            ), (("speech_act", "plan"), ("assertion_status", "conditional"))),)),
        (CandidateVariant("联系人只有明天不下雨才去露营。", speech_act="plan", assertion_status="conditional"),),
        (CandidateVariant("联系人明天一定去露营。"),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：现场工作限定", "condition",
            (("self", "我只有周三去现场办公，其他工作日都远程办公。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("self", "auto", (
                r"(?:用户)?(?:只有|仅在|仅)周三(?:去)?现场办公[，,](?:其他|其余)工作日(?:都)?远程办公[。]?",
            )),)),
        (CandidateVariant("用户仅在周三现场办公，其他工作日远程办公。", subject="self"),),
        (CandidateVariant("用户每个工作日都在现场办公。", subject="self"),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：姐姐职业", "reported",
            (("contact", "我姐在苏州做设计，我在无锡做仓库管理。"),), (0,), "auto",
            expected_claims=(
                ClaimExpectation("contact", "pending", (
                    r"(?:据联系人说[，,])?联系人的姐姐在苏州(?:做设计|从事设计工作|当设计师)[。]?",
                ), (("speech_act", "report"), ("assertion_status", "reported"))),
                ClaimExpectation("contact", "auto", (
                    r"(?:联系人)?在无锡(?:做仓库管理|管理仓库|负责仓库管理)[。]?",
                )),)),
        (CandidateVariant("联系人的姐姐在苏州从事设计工作。", speech_act="report", assertion_status="reported"),
         CandidateVariant("联系人在无锡管理仓库。")),
        (CandidateVariant("联系人在苏州做设计。"),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：跨消息第三人", "reference",
            (("self", "老陈现在住哪里？"), ("contact", "他住天津，我住重庆。")), (1,), "auto",
            expected_claims=(
                ClaimExpectation("contact", "pending", (
                    r"(?:据联系人说[，,])?老陈(?:住在|住|居住在)天津[。]?",
                ), (("speech_act", "report"), ("assertion_status", "reported"))),
                ClaimExpectation("contact", "auto", (r"(?:联系人)?(?:住在|住|居住在)重庆[。]?",)),)),
        (CandidateVariant("老陈住在天津。", source_indices=(0, 1), speech_act="report", assertion_status="reported"),
         CandidateVariant("联系人居住在重庆。", source_indices=(1,))),
        (CandidateVariant("联系人住在天津。", source_indices=(0, 1)),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：工作期间跨度", "time",
            (("self", "本周一到周三临时在南区值班，周四回原办公室。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("self", "auto", (
                r"(?:用户)?本周(?:一到周三|一至周三|周一至周三)临时在南区值班[。]?",
            ), valid_at_iso="2026-09-14T00:00:00+00:00", invalid_at_iso="2026-09-17T00:00:00+00:00"),)),
        (CandidateVariant("用户本周一至周三临时在南区值班。", subject="self",
            valid_at_iso="2026-09-14T00:00:00+00:00", invalid_at_iso="2026-09-17T00:00:00+00:00"),),
        (CandidateVariant("用户本周一临时在南区值班。", subject="self",
            valid_at_iso="2026-09-14T00:00:00+00:00", invalid_at_iso="2026-09-15T00:00:00+00:00"),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：历史学习时间", "time",
            (("contact", "我是去年春天学会游泳的，不是今年。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("contact", "auto", (
                r"(?:联系人)?(?:去年春天|去年春季)(?:学会了|学会)游泳(?:[，,]不是今年)?[。]?",
            )),)),
        (CandidateVariant("联系人去年春季学会了游泳。"),),
        (CandidateVariant("联系人今年春天学会了游泳。"),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：取消安排", "time",
            (("contact", "我们原定周六去看展览，已经取消了。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("shared", "auto", (
                r"(?:双方|我们)(?:原定|原计划)周六(?:去)?看展览(?:的安排)?(?:已经|已)?取消(?:了)?[。]?",
            )),)),
        (CandidateVariant("双方原定周六看展览的安排已取消。", subject="shared"),),
        (CandidateVariant("双方周六照常去看展览。", subject="shared"),),
    ),
    CandidateChallenge(
        EvaluationCase("严格：当前与未来分离", "time",
            (("contact", "我现在在南京工作，下个月准备去青岛参加培训。"),), (0,), "auto",
            expected_claims=(
                ClaimExpectation("contact", "auto", (r"(?:联系人)?(?:现在|目前|当前)?在南京工作[。]?",)),
                ClaimExpectation("contact", "pending", (
                    r"(?:联系人)?下个月(?:准备|计划|打算)去青岛(?:参加培训|培训)[。]?",
                ), (("speech_act", "plan"),))),),
        (CandidateVariant("联系人目前在南京工作。"),
         CandidateVariant("联系人下个月计划去青岛参加培训。", speech_act="plan")),
        (CandidateVariant("联系人目前在南京工作。"), CandidateVariant("联系人已在青岛参加培训。")),
    ),
    CandidateChallenge(
        EvaluationCase("严格：跨话题拼接", "reference",
            (("contact", "我平时喜欢喝红茶。"), ("contact", "另外，下周计划去厦门参展。")), (0, 1), "auto",
            expected_claims=(
                ClaimExpectation("contact", "auto", (r"(?:联系人)?(?:平时)?(?:喜欢喝|爱喝|偏爱)红茶[。]?",)),
                ClaimExpectation("contact", "pending", (
                    r"(?:联系人)?下周(?:计划|准备|打算)去厦门(?:参展|参加展会)[。]?",
                ), (("speech_act", "plan"),))),),
        (CandidateVariant("联系人爱喝红茶。"),
         CandidateVariant("联系人下周计划去厦门参展。", source_indices=(1,), speech_act="plan")),
        (CandidateVariant("联系人喜欢去厦门喝红茶。", source_indices=(0, 1)),), "holdout",
    ),
    CandidateChallenge(
        EvaluationCase("严格：明确职业正向", "subject",
            (("self", "我在宁波的博物馆做讲解员，已经工作三年了。"),), (0,), "auto",
            expected_claims=(ClaimExpectation("self", "auto", (
                r"(?:用户)?在宁波(?:的)?博物馆(?:做讲解员|担任讲解员|从事讲解工作)[，,](?:已经|已)?工作(?:三|3)年(?:了)?[。]?",
            )),)),
        (CandidateVariant("用户在宁波博物馆担任讲解员，已工作三年。", subject="self"),),
        (CandidateVariant("联系人在宁波博物馆担任馆长，已工作五年。"),),
    ),
)

SEMANTIC_CASES: tuple[EvaluationCase, ...] = tuple(
    challenge.case for challenge in SEMANTIC_CHALLENGES
)
