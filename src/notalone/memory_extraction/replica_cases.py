"""方法复刻的固定合成场景；中文语义答案不使用正则或模型打分。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import NAMESPACE_URL, uuid5

from notalone.memory_extraction.models import (
    MAX_TARGET_MESSAGES_PER_WINDOW,
    ExtractionWindow,
    MessageRef,
    MessageSender,
)


@dataclass(frozen=True, slots=True)
class TimeOracle:
    """时间字段独立答案；allowed 中的 None 必须显式列出。"""

    mode: Literal["ignore", "must_null", "allowed"] = "ignore"
    allowed: tuple[str | None, ...] = ()


@dataclass(frozen=True, slots=True)
class ReplicaClaim:
    """盲评需要保留的独立主张，不要求固定措辞或候选条数。"""

    claim_id: str
    subject: Literal["self", "contact", "shared"]
    meaning: str
    qualifiers: tuple[str, ...]
    allowed_destinations: tuple[Literal["auto", "pending", "none"], ...]
    valid_at: TimeOracle = TimeOracle()
    invalid_at: TimeOracle = TimeOracle()
    source_indices: tuple[int, ...] = ()


@dataclass(frozen=True, slots=True)
class ReplicaCase:
    """消息、目标边界和答案均在运行任何模型前固定。"""

    case_id: str
    split: Literal["development", "holdout"]
    dimension: str
    messages: tuple[tuple[str, str, str | None], ...]
    targets: tuple[int, ...]
    gold: tuple[ReplicaClaim, ...]
    forbidden: tuple[str, ...]


def build_replica_window(case: ReplicaCase) -> ExtractionWindow:
    """只构造一个合成联系人窗口；未知时间不使用当前时间补齐。"""
    if (
        not case.targets
        or len(case.targets) > MAX_TARGET_MESSAGES_PER_WINDOW
        or len(set(case.targets)) != len(case.targets)
        or any(index < 0 or index >= len(case.messages) for index in case.targets)
    ):
        raise ValueError("目标序号必须唯一、属于合成窗口并遵守目标预算。")
    messages = tuple(
        MessageRef(
            message_id=uuid5(NAMESPACE_URL, f"notalone-replica/{case.case_id}/{index}"),
            text=text,
            sender=MessageSender(sender),
            occurred_at=datetime.fromisoformat(time_iso) if time_iso is not None else None,
        )
        for index, (sender, text, time_iso) in enumerate(case.messages)
    )
    return ExtractionWindow(
        owner_id=uuid5(NAMESPACE_URL, "notalone-replica/owner"),
        contact_id=uuid5(NAMESPACE_URL, f"notalone-replica/contact/{case.case_id}"),
        messages=messages,
        target_message_ids=tuple(messages[index].message_id for index in case.targets),
    )


_NULL = TimeOracle("must_null")
_CAUTIOUS: tuple[Literal["auto", "pending", "none"], ...] = ("auto", "pending")
_PENDING: tuple[Literal["auto", "pending", "none"], ...] = ("pending",)


def _claim(
    claim_id: str,
    meaning: str,
    qualifiers: tuple[str, ...],
    source_indices: tuple[int, ...],
    *,
    subject: Literal["self", "contact", "shared"] = "contact",
    destinations: tuple[Literal["auto", "pending", "none"], ...] = _CAUTIOUS,
    valid_at: TimeOracle = _NULL,
    invalid_at: TimeOracle = _NULL,
) -> ReplicaClaim:
    return ReplicaClaim(
        claim_id, subject, meaning, qualifiers, destinations,
        valid_at, invalid_at, source_indices,
    )


REPLICA_CASES: tuple[ReplicaCase, ...] = (
    ReplicaCase(
        "dev-01", "development", "subject",
        (
            ("self", "我固定每周日练陶笛，你还每周三练单簧管吗？", "2026-09-08T19:00:00+08:00"),
            ("contact", "对，我每周三练单簧管，陶笛是你的课程。", "2026-09-08T19:01:00+08:00"),
        ), (0, 1),
        (
            _claim("dev-01-owner", "用户固定每周日练习陶笛。", ("每周日", "主体为用户"), (0,), subject="self"),
            _claim("dev-01-contact", "联系人每周三练习单簧管。", ("每周三", "主体为联系人"), (0, 1)),
        ),
        ("交换双方的乐器或练习日。", "把问题本身当成已经确定的事实，而不使用回答。"),
    ),
    ReplicaCase(
        "dev-02", "development", "reference",
        (
            ("self", "你那条手织毯收尾了吗？", "2026-09-17T20:01:00+08:00"),
            ("contact", "昨晚弄好了，总共用掉六团线。", "2026-09-17T20:02:00+08:00"),
        ), (1,),
        (_claim("dev-02-blanket", "联系人完成了手织毯，共使用六团线。",
                ("已经完成", "六团线", "完成于原话的昨晚，即2026-09-16晚；不能当成开始日期"), (0, 1)),),
        ("用户完成了毯子。", "六条毯子、六米线或仍未完成。", "用保存日期或消息日期充当毯子开始制作日。"),
    ),
    ReplicaCase(
        "dev-03", "development", "reported",
        (("contact", "我表姐准备接手一家装裱店，还没签约。", "2026-09-19T10:00:00+08:00"),), (0,),
        (_claim("dev-03-cousin", "联系人说其表姐准备接手一家装裱店，目前尚未签约。",
                ("表姐而非联系人", "准备而非已经接手", "尚未签约", "第三人转述"), (0,), destinations=_PENDING),),
        ("联系人经营装裱店。", "表姐已经买下或已经接手店铺。", "把第三人计划作为确定的本人事实自动采纳。"),
    ),
    ReplicaCase(
        "dev-04", "development", "degree",
        (("contact", "我只在休息日做木工，并不是每晚都做。", "2026-09-20T18:00:00+08:00"),), (0,),
        (_claim("dev-04-woodwork", "联系人只在休息日做木工，并非每晚都做。",
                ("只在休息日", "并非每晚"), (0,)),),
        ("每天或每晚做木工。", "完全不做木工。", "把休息日限定丢掉只剩喜欢木工。"),
    ),
    ReplicaCase(
        "dev-05", "development", "condition",
        (("contact", "要是旧屋的隔音验收通过，我才把周末乐队排练搬回家；没过就仍在公共排练室。", "2026-09-21T17:00:00+08:00"),), (0,),
        (_claim("dev-05-rehearsal", "联系人仅在旧屋隔音验收通过时，才会把周末乐队排练搬回家；否则仍在公共排练室。",
                ("验收通过是必要前提", "尚属有条件的搬迁安排", "未通过仍在公共排练室", "周末排练"), (0,), destinations=_PENDING),),
        ("已经把排练搬回家。", "无条件决定搬回家。", "验收已通过。", "把循环周末安排编成某个具体日期。"),
    ),
    ReplicaCase(
        "dev-06", "development", "cross_topic",
        (
            ("contact", "我订了一个榉木书架。", "2026-09-22T14:00:00+08:00"),
            ("self", "你哥哥开的那家店最近怎么样？", "2026-09-22T14:01:00+08:00"),
            ("contact", "他给店里换了收银机。", "2026-09-22T14:02:00+08:00"),
        ), (0, 2),
        (
            _claim("dev-06-shelf", "联系人订购了一个榉木书架。", ("一个", "榉木", "已订购"), (0,)),
            _claim("dev-06-brother", "联系人说其哥哥给哥哥的店更换了收银机。",
                   ("哥哥而非联系人", "哥哥的店", "第三人转述", "与书架购买是不同事项"), (1, 2), destinations=_PENDING),
        ),
        ("联系人开店或更换了自家店的收银机。", "把书架与哥哥的收银机拼成同一笔购买或用途。"),
    ),
    ReplicaCase(
        "dev-07", "development", "time_interval",
        (("contact", "从明天零点到周日24点，我都在社区书展做志愿者。", "2026-10-16T23:50:00+08:00"),), (0,),
        (_claim("dev-07-volunteer", "联系人计划在2026-10-17零点至2026-10-19零点期间，在社区书展做志愿者。",
                ("完整期间覆盖周六与周日", "来源周五夜晚的明天", "未来安排而非已经发生"), (0,), destinations=_PENDING,
                valid_at=TimeOracle("allowed", ("2026-10-17T00:00:00+08:00",)),
                invalid_at=TimeOracle("allowed", ("2026-10-19T00:00:00+08:00",))),),
        ("只保留周六或周日一天。", "把周日24点归一化为周日零点。", "相对日期参考运行当天。"),
    ),
    ReplicaCase(
        "dev-08", "development", "noise",
        (
            ("contact", "在吗，[捂脸]哈哈。", "2026-09-23T11:00:00+08:00"),
            ("self", "[文件]", "2026-09-23T11:01:00+08:00"),
        ), (0, 1), (),
        ("从语气或表情推断长期性格。", "猜测文件内容或文件类型偏好。", "把问候改写成长期记忆。"),
    ),
    ReplicaCase(
        "hold-01", "holdout", "subject",
        (
            ("self", "我现在做自行车维修，你仍然是配音师吧。", "2026-04-09T09:30:00+08:00"),
            ("contact", "是，我是配音师；修车是你的工作。", "2026-04-09T09:31:00+08:00"),
        ), (0, 1),
        (
            _claim("hold-01-owner", "用户从事自行车维修工作。", ("主体为用户", "自行车维修"), (0,), subject="self"),
            _claim("hold-01-contact", "联系人是配音师。", ("主体为联系人", "职业并非自行车维修"), (0, 1)),
        ),
        ("交换两人的职业。", "推断任一职业的实际入职日期。"),
    ),
    ReplicaCase(
        "hold-02", "holdout", "reference",
        (
            ("self", "我寄给你的茶壶处理得怎么样？", "2026-04-10T16:20:00+08:00"),
            ("contact", "修好了，裂缝在底部，我没有换壶。", "2026-04-10T16:21:00+08:00"),
        ), (1,),
        (_claim("hold-02-teapot", "用户寄给联系人的茶壶已修好；裂缝位于底部，联系人没有更换茶壶。",
                ("修复的是用户寄来的茶壶", "底部裂缝", "已修好", "没有换壶", "原话未明确亲手维修者"), (0, 1)),),
        ("捏造用户或联系人亲手维修，原话未明确维修者。", "把修好改成换了一把新壶。", "编造裂缝材质、修复费或其他位置。"),
    ),
    ReplicaCase(
        "hold-03", "holdout", "reference_unknown",
        (
            ("contact", "阿澄和小陆都提到他们的旧相机。", "2026-04-11T15:00:00+08:00"),
            ("contact", "他说下次想带来给我看看。", "2026-04-11T15:01:00+08:00"),
        ), (1,), (),
        ("把他确定为阿澄或小陆。", "推断相机归联系人所有。", "从一次含糊的第三人安排建立长期事实。"),
    ),
    ReplicaCase(
        "hold-04", "holdout", "attribution",
        (
            ("self", "你抽屉里那套印章是谁的？", "2026-04-12T10:00:00+08:00"),
            ("contact", "小姨的，不是我的，她暂放在我这里。", "2026-04-12T10:01:00+08:00"),
        ), (1,),
        (_claim("hold-04-stamps", "联系人说其抽屉里的那套印章属于小姨，小姨暂存在联系人处，并非联系人所有。",
                ("所有者是小姨", "联系人只是暂存", "并非联系人所有", "第三人转述", "暂存何时结束未知", "允许空或消息观察起点，不等于真实暂存开始日"),
                (0, 1), destinations=_PENDING,
                valid_at=TimeOracle("allowed", (None, "2026-04-12T10:01:00+08:00"))),),
        ("联系人拥有这套印章。", "把暂存改成赠送。", "为暂存套固定结束日期。"),
    ),
    ReplicaCase(
        "hold-05", "holdout", "negation_quantity",
        (("contact", "我没有买电动滑板车，只有一辆折叠自行车，不能写成我有两辆车。", "2026-04-13T18:00:00+08:00"),), (0,),
        (
            _claim("hold-05-no-scooter", "联系人没有购买电动滑板车。", ("否定购买", "电动滑板车"), (0,)),
            _claim("hold-05-bike", "联系人只有一辆折叠自行车。", ("只有一辆", "折叠自行车", "不能扩大为两辆车"), (0,)),
        ),
        ("购买或拥有电动滑板车。", "两辆自行车或两辆车。", "否定自行车所有权。"),
    ),
    ReplicaCase(
        "hold-06", "holdout", "degree_quantity",
        (("contact", "我不是每天熬果酱，大概每个月做一次；糖量比以前减半，不是完全不放糖。", "2026-04-14T08:30:00+08:00"),), (0,),
        (
            _claim("hold-06-frequency", "联系人大约每个月熬一次果酱，并非每天。", ("大约", "每个月一次", "不是每天"), (0,)),
            _claim("hold-06-sugar", "联系人熬果酱时用糖量比以前减半，但仍会放糖。", ("比以前减半", "并非完全无糖"), (0,)),
        ),
        ("每天做果酱。", "完全不放糖。", "减成原来的三分之一或编出具体克数。", "把大概变成毫无例外。"),
    ),
    ReplicaCase(
        "hold-07", "holdout", "condition_quantity",
        (("contact", "除非人数涨到四人以上，否则我不接周日晚的桥牌局。", "2026-04-15T13:00:00+08:00"),), (0,),
        (_claim("hold-07-bridge", "联系人仅在人数达到四人或更多时才考虑接受周日晚的桥牌局；否则不接受。",
                ("人数至少四人，包括恰好四人", "必要条件而非人数满足必定接受", "周日晚", "尚无某次具体日期"), (0,), destinations=_PENDING),),
        ("不足四人就接受。", "每周日晚都参加。", "人数达到四人必定参加。", "把四人以上改成严格超过四人。", "编出某一周日日期。"),
    ),
    ReplicaCase(
        "hold-08", "holdout", "reported_self",
        (("contact", "我妈学会了琉璃烧制，我还只会画草图。", "2026-04-16T17:30:00+08:00"),), (0,),
        (
            _claim("hold-08-mother", "联系人说其母亲已经学会琉璃烧制。", ("母亲而非联系人", "已经学会", "第三人转述"), (0,), destinations=_PENDING),
            _claim("hold-08-contact", "联系人目前还只会画草图。", ("只会画草图", "不能升级为会琉璃烧制"), (0,)),
        ),
        ("联系人已经学会琉璃烧制。", "母亲只会画草图。", "把技能推断为职业、收入或执业资格。"),
    ),
    ReplicaCase(
        "hold-09", "holdout", "reported_plan",
        (("contact", "我姨父说他想把海边小屋改成民宿，许可证还没批下来。", "2026-04-17T12:00:00+08:00"),), (0,),
        (_claim("hold-09-uncle", "联系人转述姨父想把海边小屋改成民宿，但许可证尚未获批。",
                ("姨父的意向", "未完成改造", "许可证尚未获批", "转述不能升级为已营业"), (0,), destinations=_PENDING),),
        ("联系人经营民宿。", "姨父已经改造或已经开业。", "许可证已经批准。"),
    ),
    ReplicaCase(
        "hold-10", "holdout", "cross_topic",
        (
            ("contact", "我把用了五年的音箱送给邻居了。", "2026-04-18T20:00:00+08:00"),
            ("self", "你说新盆栽摆在哪里？", "2026-04-18T20:01:00+08:00"),
            ("contact", "窗台上，买的是琴叶榕。", "2026-04-18T20:02:00+08:00"),
        ), (0, 2),
        (
            _claim("hold-10-speaker", "联系人把自己用了五年的音箱送给了邻居。", ("已送出", "五年的使用时长", "音箱而非盆栽"), (0,)),
            _claim("hold-10-plant", "联系人新买的盆栽是琴叶榕，摆在窗台上。", ("琴叶榕", "窗台", "新买", "与送音箱不同事项"), (1, 2)),
        ),
        ("邻居买琴叶榕或拥有五年的琴叶榕。", "音箱放窗台上。", "因为用了五年就推算出精确购买日期。"),
    ),
    ReplicaCase(
        "hold-11", "holdout", "time_anchor",
        (
            ("contact", "后天起到1月4日止，我在临时仓库值班。", "2025-12-31T23:55:00+08:00"),
            ("self", "新年快乐，我这边已经过零点了。", "2026-01-01T00:05:00+08:00"),
        ), (0,),
        (_claim("hold-11-duty", "联系人计划从2026-01-02起至2026-01-04结束在临时仓库值班。",
                ("相对日期锚定12月31日的联系人消息", "包含1月4日整日", "未来临时安排"), (0,), destinations=_PENDING,
                valid_at=TimeOracle("allowed", ("2026-01-02T00:00:00+08:00",)),
                invalid_at=TimeOracle("allowed", ("2026-01-05T00:00:00+08:00",))),),
        ("参考后一条上下文把后天推成1月3日。", "以运行当天计算。", "1月4日零点已经失效。"),
    ),
    ReplicaCase(
        "hold-12", "holdout", "time_timezone",
        (("contact", "当地11月3日早上7点到11月6日18点，我负责替大家保管展柜钥匙。", "2026-11-01T10:00:00+09:00"),), (0,),
        (_claim("hold-12-keys", "联系人计划在2026-11-03当地7点至2026-11-06当地18点期间，为大家保管展柜钥匙。",
                ("消息时区为+09:00", "准确起止钟点", "未来保管责任", "不能删去起止日"), (0,), destinations=_PENDING,
                valid_at=TimeOracle("allowed", ("2026-11-03T07:00:00+09:00",)),
                invalid_at=TimeOracle("allowed", ("2026-11-06T18:00:00+09:00",))),),
        ("套用+08:00导致瞬间相差一小时。", "把18点改成午夜。", "已开始保管。"),
    ),
    ReplicaCase(
        "hold-13", "holdout", "time_precision",
        (("contact", "我在2021年通过了钟表维修培训，具体哪天实在记不住了。", "2026-05-03T14:00:00+08:00"),), (0,),
        (_claim("hold-13-training", "联系人在2021年通过了钟表维修培训，具体日期未知。",
                ("已经通过培训", "年份2021", "具体日期明确未知", "不推断职业或证书等级"), (0,)),),
        ("编成2021年1月1日、来源消息当天或培训开始日。", "把培训通过推断为持有某项许可证。"),
    ),
    ReplicaCase(
        "hold-14", "holdout", "time_unknown",
        (
            ("self", "你这次去哪里支援？", "2026-04-03T10:00:00+08:00"),
            ("contact", "下周我会在乡镇图书馆整理地方志，到周五结束。", None),
        ), (1,),
        (_claim("hold-14-library", "联系人计划在其所说的下周到周五期间，在乡镇图书馆整理地方志；该消息时间未知，不能确定绝对日期。",
                ("未来计划", "下周到周五的完整相对期间", "消息时间未知", "不能借前一条消息时间推算"), (0, 1), destinations=_PENDING),),
        ("借用户消息日期、运行日期或保存日期推算具体下周。", "把相对日期未知改成无期限状态。"),
    ),
    ReplicaCase(
        "hold-15", "holdout", "time_historical_state",
        (("contact", "去年8月1日到10月31日我的排班一直是夜班，11月起就不是夜班了。", "2026-02-05T09:00:00+08:00"),), (0,),
        (_claim("hold-15-shift", "联系人2025-08-01至2025-10-31的排班是夜班，2025年11月起已不再是夜班。",
                ("历史状态而非现在仍上夜班", "完整历史日期范围", "11月起已结束", "不推断之后一定是白班"), (0,),
                valid_at=TimeOracle("allowed", ("2025-08-01T00:00:00+08:00",)),
                invalid_at=TimeOracle("allowed", ("2025-11-01T00:00:00+08:00",))),),
        ("当前仍上夜班。", "用2026年2月5日充当夜班开始日。", "编出新的白班工作或离职。"),
    ),
    ReplicaCase(
        "hold-16", "holdout", "time_overnight",
        (("contact", "上周四22点到周五凌晨2点，我给公益直播做布景；这周没再排这件事。", "2026-03-10T09:10:00+08:00"),), (0,),
        (_claim("hold-16-stage", "联系人2026-03-05的22点至2026-03-06凌晨2点给公益直播做布景；来源所述本周没有再次安排此事。",
                ("上周四跨至周五凌晨", "完整四小时区间", "已发生的历史工作", "本周未再次安排，不能升级为固定职业"), (0,),
                valid_at=TimeOracle("allowed", ("2026-03-05T22:00:00+08:00",)),
                invalid_at=TimeOracle("allowed", ("2026-03-06T02:00:00+08:00",))),),
        ("把凌晨2点归到周四。", "每天固定做直播布景。", "删去跨日结束时间或把当前周当历史周。"),
    ),
)


DEVELOPMENT_CASES = tuple(case for case in REPLICA_CASES if case.split == "development")
HOLDOUT_CASES = tuple(case for case in REPLICA_CASES if case.split == "holdout")
