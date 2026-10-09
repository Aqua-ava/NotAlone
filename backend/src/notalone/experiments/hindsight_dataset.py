"""Hindsight 对照实验的预标注合成资料与冻结清单。"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid5

from notalone.scopes import ContactScope

DATASET_ID = "hindsight-synthetic-v2"
SEED = 20261004
NAMESPACE = UUID("fd1265ef-6ba1-4bb8-8571-36627e293808")
QUERY_TIMESTAMP = datetime(2026, 10, 4, 0, tzinfo=timezone.utc)


def stable_id(key: str) -> UUID:
    return uuid5(NAMESPACE, f"{DATASET_ID}:{SEED}:{key}")


@dataclass(frozen=True, slots=True)
class SyntheticMemory:
    """预先固定的已采纳快照；source 也只是新建合成标识。"""

    memory_id: UUID
    scope: ContactScope
    text: str
    role: str
    source_ids: tuple[UUID, ...]
    category: str = "preference"
    adoption_method: str = "auto"
    confidence: float = 0.9
    revision: int = 1
    status: str = "active"
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    layer: Literal["contact", "owner"] = "contact"


@dataclass(frozen=True, slots=True)
class SyntheticQuery:
    query_id: str
    split: str
    group: str
    scope: ContactScope
    text: str
    contact_gold: tuple[UUID, ...] = ()
    owner_gold: tuple[UUID, ...] = ()
    rationale: str = ""


@dataclass(frozen=True, slots=True)
class SyntheticDataset:
    dataset_id: str
    seed: int
    query_timestamp: datetime
    memories: tuple[SyntheticMemory, ...]
    queries: tuple[SyntheticQuery, ...]


@dataclass(frozen=True, slots=True)
class Scenario:
    key: str
    gold: tuple[str, str]
    paraphrases: tuple[str, str, str]
    direct: str
    negatives: tuple[str, ...]
    rationale: str


def _scope(split: str, suffix: str = "primary") -> ContactScope:
    return ContactScope(stable_id(f"{split}:owner"), stable_id(f"{split}:{suffix}"))


# gold 是回复当前问题可用的资料，不是对现实真值的标注；不根据检索输出来选择。
FINAL_SCENARIOS = (
    Scenario(
        "coffee",
        ("联系人喝酸味咖啡会胃不舒服。", "联系人喝牛奶会腹胀，饮品需要不加奶。"),
        (
            "帮你点杯提神的，豆子口味和配料有什么要避开？",
            "下午买喝的给你，怕肚子难受，选哪种才稳妥？",
            "我顺路带一杯给你，别让消化系统受罪，要怎么下单？",
        ),
        "你喝酸味咖啡会胃不舒服，喝牛奶会腹胀，点饮品怎么避开？",
        (
            "联系人办公室的咖啡机每周五清洗。",
            "联系人同事喜欢酸味咖啡，这不是联系人自己的口味。",
            "联系人负责给会议买牛奶，自己不喝。",
            "联系人收藏蓝色咖啡杯。",
            "联系人姐姐在咖啡店工作。",
            "联系人保存过咖啡豆包装的设计照片。",
            "联系人家里茶杯的容量是三百毫升。",
            "联系人常去的咖啡店九点开门。",
            "联系人曾帮朋友充值咖啡礼品卡。",
            "联系人把茶匙放在左边抽屉。",
            "联系人给办公室订过纸杯。",
            "联系人读过咖啡产地的科普。",
            "联系人有一张已经用完的饮品优惠券。",
        ),
        "本次为本人下单；胃部刺激和奶配料直接约束选择，店务及他人偏好不支持此次选择。",
    ),
    Scenario(
        "hiking",
        (
            "联系人膝盖受伤恢复中，不能爬陡坡。",
            "联系人愿意走平缓短路线，途中要有休息点。",
        ),
        (
            "周末带你去山里透气，路线强度怎样安排才不伤腿？",
            "想陪你在户外走走，别太折腾身体，挑什么路合适？",
            "这次踏青照顾你的恢复情况，路程和停留该怎么定？",
        ),
        "膝盖恢复不能爬陡坡，平缓短路线要有休息点，周末怎么安排？",
        (
            "联系人同事喜欢爬陡坡，不代表联系人能去。",
            "联系人给登山协会做过海报。",
            "联系人把旧登山杖借给了朋友。",
            "联系人存过一张山顶日出的图片。",
            "联系人家的登山鞋放在门口。",
            "联系人帮家人买过运动护膝。",
            "联系人看过高山植物的纪录片。",
            "联系人背包上的拉链去年修过。",
            "联系人在旅行相册里整理过山景。",
            "联系人知道公园入口有停车场。",
            "联系人给同事转过越野赛报名链接。",
            "联系人保留了登山社旧名片。",
            "联系人用绿色标签标记户外照片。",
        ),
        "此次本人轻度步行，恢复限制与可接受路线有用；装备、他人竞赛和照片不是体力授权。",
    ),
    Scenario(
        "meeting",
        (
            "联系人晚上要照顾孩子，不能参加晚间会议。",
            "联系人无法到会时希望收到文字纪要。",
        ),
        (
            "准备约你讨论工作，下班后的时间合适吗，缺席怎么同步？",
            "大家想晚一点开碰头会，你参与不了的话怎样跟进？",
            "项目讨论放在夜里行不行，怎样让你也掌握结论？",
        ),
        "你晚上照顾孩子不能参加晚间会议，无法到会要文字纪要，怎么安排？",
        (
            "联系人同事习惯晚上开会。",
            "联系人为会议室买过白板笔。",
            "联系人孩子的书包是蓝色。",
            "联系人曾整理白天会议签到表。",
            "联系人会使用投影仪。",
            "联系人办公室会议室在二楼。",
            "联系人保存过会议模板。",
            "联系人给外地同事订过会议酒店。",
            "联系人在日历里给培训用黄色标签。",
            "联系人曾帮客户测试麦克风。",
            "联系人知道前台负责开会议室门。",
            "联系人将旧议程归档。",
            "联系人给团队设计过会议封面。",
        ),
        "只标注本人晚间出席限制和缺席同步方式，不把同事习惯或设备知识当作本人可参加。",
    ),
    Scenario(
        "train",
        (
            "联系人坐长途火车容易晕，希望坐靠窗位置。",
            "联系人睡眠浅，不坐通宵出发的列车。",
        ),
        (
            "帮你订去外地的高铁票，出发时段和座位有啥讲究？",
            "这趟铁路行程挺远，怎么买票让你休息好也少难受？",
            "一起搭动车出城，车次和位置选怎样的更舒服？",
        ),
        "长途晕车要靠窗，睡眠浅不坐通宵列车，怎么订票？",
        (
            "联系人给同事买过夜车票，自己没有同行。",
            "联系人妈妈喜欢靠过道。",
            "联系人把旧车票收进相册。",
            "联系人知道车站南口有便利店。",
            "联系人旅行箱是灰色。",
            "联系人曾研究铁路线路图。",
            "联系人帮朋友找过失物招领电话。",
            "联系人家的行李秤放在柜子里。",
            "联系人给车站照片加过日期。",
            "联系人收藏过列车模型。",
            "联系人打印过朋友的行程单。",
            "联系人看过高铁建设纪录片。",
            "联系人把退票规则链接存在书签里。",
        ),
        "本次本人长途订票，座位与夜间乘车限制有效；代购及家人的座位偏好不适用。",
    ),
    Scenario(
        "movie",
        ("联系人不看恐怖片，容易做噩梦。", "联系人看外语电影需要中文字幕。"),
        (
            "今晚挑部片子一起看，题材和版本怎么选？",
            "想找个放松的观影安排，有什么类型该绕开，语言有要求吗？",
            "我来找电影资源，怎样选才不会让你看完睡不好或听不懂？",
        ),
        "不看恐怖片怕噩梦，外语电影要中文字幕，今晚选什么版本？",
        (
            "联系人弟弟喜欢恐怖片。",
            "联系人做过电影节海报。",
            "联系人保存了一张影院地图。",
            "联系人给同事买过首映票。",
            "联系人收藏老电影的票根。",
            "联系人常去的影院有三个入口。",
            "联系人去年修过投影仪。",
            "联系人把影评链接按年份整理。",
            "联系人了解一位导演的获奖经历。",
            "联系人给朋友找过英文电影台词。",
            "联系人家的遥控器放在茶几上。",
            "联系人曾拍摄影院招牌。",
            "联系人换过电视壁挂架。",
        ),
        "标注本次观影题材和语言可理解性，其他人的口味与电影周边不限制选片。",
    ),
    Scenario(
        "meal",
        ("联系人对花生过敏，吃饭要避开花生及花生油。", "联系人日常吃素，不吃肉类。"),
        (
            "请你吃顿饭，菜单有哪些成分绝对不能碰？",
            "我来订餐，想兼顾你的饮食方式和身体禁忌，该怎么备注？",
            "一起去聚餐，给店家说清哪些食材要排除？",
        ),
        "花生过敏不能吃花生油，日常吃素不吃肉，菜单怎么备注？",
        (
            "联系人为同事订过花生酥，自己没吃。",
            "联系人父亲喜欢炖肉。",
            "联系人常去的餐厅周一休息。",
            "联系人收藏过餐厅菜单设计。",
            "联系人帮朋友买过烧烤工具。",
            "联系人家的盘子是白色。",
            "联系人拍过餐厅门口的招牌。",
            "联系人用绿色文件夹保存发票。",
            "联系人会使用餐厅预约系统。",
            "联系人帮邻居搬过餐桌。",
            "联系人知道餐厅二楼有包间。",
            "联系人曾翻译餐馆名称。",
            "联系人给同事介绍过厨具店。",
        ),
        "本人安全禁忌和素食决定菜单；代购肉食与花生并不表示本人食用。",
    ),
    Scenario(
        "gift",
        (
            "联系人喜欢纸质小说，收礼时愿意收到书。",
            "联系人经常出差，无人照料植物，不想收到盆栽。",
        ),
        (
            "想送你个日常能用的小礼物，哪类你会喜欢，哪类会添麻烦？",
            "挑一份不增加照顾负担的心意，给你买什么合适？",
            "给你选件礼物，你常不在家，怎样兼顾爱好和打理成本？",
        ),
        "喜欢纸质小说愿意收书，经常出差不想收盆栽，送什么？",
        (
            "联系人给母亲买过盆栽。",
            "联系人同事只看电子书。",
            "联系人知道书店十点关门。",
            "联系人保存过礼品包装样式。",
            "联系人家的书架有四层。",
            "联系人曾为朋友写过生日贺卡。",
            "联系人把书店小票夹在笔记本里。",
            "联系人帮公司采购过礼品袋。",
            "联系人出差箱上的标签是蓝色。",
            "联系人记录过花店地址。",
            "联系人给姐姐转过园艺文章。",
            "联系人收藏纸袋不等于想收袋子。",
            "联系人整理过赠书活动名单。",
        ),
        "本次为本人选择礼物，小说兴趣与盆栽维护限制相关；送给别人和周边信息不代表本人愿望。",
    ),
    Scenario(
        "car",
        (
            "联系人坐汽车易晕，长途希望坐前排。",
            "联系人坐汽车时不看手机，否则更容易恶心。",
        ),
        (
            "开车带你远行，座位和路上消遣怎么安排才舒服？",
            "搭我的车出去玩，如何减少你路途中的不适？",
            "这次自驾一路要坐挺久，坐哪里、怎么打发时间对你好一点？",
        ),
        "长途乘车易晕要前排，不看手机避免恶心，路上怎么安排？",
        (
            "联系人朋友喜欢坐后排。",
            "联系人替父亲买过车载手机架。",
            "联系人知道附近停车场收费。",
            "联系人家的车钥匙挂在墙上。",
            "联系人保存过修车店电话。",
            "联系人给同事清洗过座套。",
            "联系人收藏了一张公路明信片。",
            "联系人会查看轮胎胎压。",
            "联系人拍过汽车展览。",
            "联系人给邻居介绍过代驾。",
            "联系人搬家时借过一辆货车。",
            "联系人旧地图放在抽屉。",
            "联系人记录过加油站营业时间。",
        ),
        "关注本人的晕车照顾方式，他人座位、代购配件和车务不构成照顾措施。",
    ),
    Scenario(
        "cat",
        (
            "联系人家里的老猫每天晚饭后需要服药。",
            "联系人家里的猫不能喝牛奶，会拉肚子。",
        ),
        (
            "今晚帮你照料毛孩子，吃完饭要做什么，喂喝的要注意啥？",
            "你不在家我代班养猫，晚间护理和饮食有哪些特别要求？",
            "替你看着那只年纪大的小家伙，晚餐后的流程和饮品怎样安排？",
        ),
        "老猫晚饭后要服药，不能喝牛奶会拉肚子，今晚怎么照料？",
        (
            "联系人邻居的猫可以喝专用猫奶，不是这只猫。",
            "联系人曾给朋友的小狗喂过药。",
            "联系人猫窝外罩是蓝色。",
            "联系人给宠物医院拍过门牌。",
            "联系人把旧猫玩具收进箱子。",
            "联系人知道宠物店周日开门。",
            "联系人收藏过猫咪表情贴纸。",
            "联系人给同事推荐过宠物摄影师。",
            "联系人家的猫抓板放在阳台。",
            "联系人曾为流浪猫活动设计海报。",
            "联系人整理过宠物发票。",
            "联系人帮姐姐搬过猫爬架。",
            "联系人保存宠物店会员卡。",
        ),
        "只涉及照料当前老猫的用药时间和牛奶禁忌，其他宠物及用品不构成护理要求。",
    ),
    Scenario(
        "exam",
        (
            "联系人备考语言考试，口语表达是薄弱项。",
            "联系人希望练习时模拟真实面试问答，不只背单词。",
        ),
        (
            "陪你准备那个语言测评，这次练什么、怎么练更有帮助？",
            "想帮你冲刺考试，哪些能力最需要补，采用什么练法？",
            "今天一起复习，怎样把时间用在你的短板上？",
        ),
        "语言考试口语表达薄弱，要模拟面试问答不只背单词，怎么练习？",
        (
            "联系人同学的短板是听力，不是联系人。",
            "联系人替弟弟打印过数学试卷。",
            "联系人考试报名表装在红色文件夹。",
            "联系人给同事借过词典。",
            "联系人知道考场地铁出口。",
            "联系人曾整理学习书架。",
            "联系人保存过考试收费收据。",
            "联系人把铅笔装在铁盒里。",
            "联系人参加过学校志愿活动。",
            "联系人给朋友转发过考试通知。",
            "联系人会操作打印机。",
            "联系人收藏一张毕业合照。",
            "联系人改过报名系统密码。",
        ),
        "当前备考的能力短板与训练方法相关；别人科目、办事和文具信息不解决复习问题。",
    ),
    Scenario(
        "move",
        (
            "联系人搬家时有易碎餐具，需要单独包裹并标记。",
            "联系人新住处搬运家具要提前预约电梯。",
        ),
        (
            "我来帮你换住处，打包和进楼运输有什么注意事项？",
            "搬运那天想少出岔子，哪些东西要特别保护，楼里要先办什么？",
            "帮你收拾行李送过去，怎么处理怕摔的东西和大件进出？",
        ),
        "搬家易碎餐具单独包裹标记，家具搬运提前预约电梯，怎么准备？",
        (
            "联系人同事的小区没有电梯，不是这个住处。",
            "联系人给朋友搬过没有餐具的办公室。",
            "联系人新家的墙是浅灰色。",
            "联系人记得旧家窗帘尺寸。",
            "联系人把旧钥匙退给房东。",
            "联系人保存过装修发票。",
            "联系人认识一家搬运公司的前台。",
            "联系人把照片放在纸箱里。",
            "联系人去年修过旧家的水龙头。",
            "联系人帮邻居安装过门铃。",
            "联系人记录过附近超市路线。",
            "联系人把旧门牌拍照留念。",
            "联系人为朋友转过租房链接。",
        ),
        "本次搬运保护与电梯手续有用，旧房和他人住宅条件不适用。",
    ),
    Scenario(
        "cook",
        ("联系人家里的烤箱坏了，暂时不能烘烤。", "联系人目前可用电磁炉做饭。"),
        (
            "去你家一起做晚餐，现在能用哪些烹饪方式？",
            "准备带食材来下厨，你家的设备能做什么、做不了什么？",
            "想在你那儿弄顿饭，选怎样的做法才用得上现有器具？",
        ),
        "烤箱坏了不能烘烤，目前能用电磁炉做饭，晚餐怎么做？",
        (
            "联系人姐姐家有可用的烤箱。",
            "联系人替公司买过燃气灶。",
            "联系人厨房围裙是黄色。",
            "联系人会整理菜谱书。",
            "联系人把餐垫放在抽屉里。",
            "联系人给邻居借过量杯。",
            "联系人保存过厨房装修图。",
            "联系人家的冰箱贴来自旅行。",
            "联系人上次帮朋友洗过锅。",
            "联系人知道厨具店地址。",
            "联系人给母亲买过烤盘。",
            "联系人收藏过甜点包装盒。",
            "联系人录过超市采购清单模板。",
        ),
        "当前本人厨房设备决定做法，家人和公司设备不表示本人家中可用。",
    ),
    Scenario(
        "run",
        (
            "联系人刚开始跑步，单次最多跑五公里。",
            "联系人周二固定休息，不安排跑步训练。",
        ),
        (
            "一起练体能，给你定距离和日程该怎样控制？",
            "想约你运动，强度和哪天停一停有什么要求？",
            "我来排我们的慢跑计划，别超出你现在能力，时间怎么选？",
        ),
        "刚开始跑步最多五公里，周二固定休息不训练，计划怎么排？",
        (
            "联系人同事能跑马拉松，不是联系人本人。",
            "联系人为姐姐买过跑步奖牌架。",
            "联系人运动鞋鞋带是白色。",
            "联系人保留了运动会合照。",
            "联系人知道体育馆入口位置。",
            "联系人帮朋友看管过赛事包。",
            "联系人保存过跑道地图。",
            "联系人收藏一个旧计时器。",
            "联系人给社团设计过运动海报。",
            "联系人读过田径比赛规则。",
            "联系人把号码布放进相册。",
            "联系人整理过运动发票。",
            "联系人上次清洗了运动背包。",
        ),
        "本人的当前能力和休息日决定训练，代购与他人能力不能用于安排。",
    ),
    Scenario(
        "hair",
        ("联系人对染发药水敏感，不接受染发。", "联系人这次只想洗剪，不做烫发。"),
        (
            "帮你预约造型服务，哪些项目要删掉，保留哪些？",
            "去理发店前我来写需求，怎样避免你皮肤不适又符合这次想法？",
            "这回整理头发，药剂和套餐怎样选才合适？",
        ),
        "染发药水敏感不能染，这次只洗剪不烫发，预约什么项目？",
        (
            "联系人姐姐喜欢烫发，不是本人的预约需求。",
            "联系人替同事买过染发梳。",
            "联系人常去的理发店有四张椅子。",
            "联系人保存过店铺营业时间。",
            "联系人给店员拍过宣传照。",
            "联系人家的吹风机是黑色。",
            "联系人把发夹放在小盒里。",
            "联系人读过发型设计史。",
            "联系人帮朋友找过假发店。",
            "联系人收藏旧店会员卡。",
            "联系人为家人买过毛巾。",
            "联系人知道店门口可停车。",
            "联系人给朋友转过造型比赛视频。",
        ),
        "本次本人项目选择与药剂禁忌相关，姐姐爱好和周边不适用。",
    ),
    Scenario(
        "concert",
        (
            "联系人怕音量太大，听演出要远离音箱。",
            "联系人看演出希望坐靠过道的位置，方便中途离开。",
        ),
        (
            "给你买演出票，位置怎么选才能舒服且方便进出？",
            "现场声音可能很响，订座时怎样照顾你的感受？",
            "一起听音乐会，哪里坐着对你更合适？",
        ),
        "怕演出音量太大要远离音箱，希望靠过道方便离开，选哪座？",
        (
            "联系人同事想站在音箱前。",
            "联系人替弟弟买过前排演出票。",
            "联系人收藏过乐队海报。",
            "联系人会给旧唱片分类。",
            "联系人知道场馆售票处位置。",
            "联系人把耳机收在书包里。",
            "联系人为社团演出做过字幕。",
            "联系人给朋友找过吉他谱。",
            "联系人读过音乐家传记。",
            "联系人家里的琴凳去年修过。",
            "联系人给姐姐买过乐器盒。",
            "联系人整理演出发票。",
            "联系人保存场馆客服电话。",
        ),
        "订座时本人噪声承受与离场方便相关，代购票和音乐周边不表示座位意愿。",
    ),
    Scenario(
        "feedback",
        (
            "联系人不喜欢当众被指出错误，工作反馈希望私下说。",
            "联系人接受反馈时希望附带具体可执行的改进建议。",
        ),
        (
            "想提醒你工作中一个问题，怎么说、在哪说比较好接受？",
            "给你提改进意见，场合和内容怎样安排才有帮助？",
            "聊聊刚才的失误，怎样沟通让你觉得受尊重又知道下一步？",
        ),
        "不喜欢当众指出错误，希望私下反馈并附具体可执行建议，怎么沟通？",
        (
            "联系人经理喜欢公开复盘，不代表联系人接受公开批评。",
            "联系人替同事写过表扬稿。",
            "联系人办公室白板是磁性的。",
            "联系人收藏项目封面模板。",
            "联系人保存过部门组织图。",
            "联系人会使用任务看板。",
            "联系人给实习生打印过培训材料。",
            "联系人旧工牌放在抽屉。",
            "联系人参与过办公室搬迁。",
            "联系人帮团队订过午餐。",
            "联系人记录过投影仪报修号码。",
            "联系人整理过去年的报销单。",
            "联系人知道公司访客登记流程。",
        ),
        "本次纠错沟通的场合与行动建议相关，管理者偏好不替代本人的接受方式。",
    ),
    Scenario(
        "father",
        (
            "联系人的父亲听力较弱，交谈时需要放慢语速。",
            "联系人的父亲在嘈杂环境里难以听清，见面宜选安静地方。",
        ),
        (
            "要和你爸爸聊聊，地点和说话方式怎样照顾他？",
            "第一次陪你见长辈，怎样让伯父能轻松听懂？",
            "想请叔叔坐下来谈谈，选哪种环境、怎么讲话合适？",
        ),
        "父亲听力较弱需放慢语速，嘈杂处听不清要安静地方，怎么见面？",
        (
            "联系人母亲喜欢热闹场所，不代表父亲适应。",
            "联系人同事说话速度很快。",
            "联系人父亲的帽子是棕色。",
            "联系人给父亲打印过旅行照片。",
            "联系人母亲会做刺绣。",
            "联系人家人保存了旧合照。",
            "联系人帮家里换过门锁。",
            "联系人知道老家邮局的位置。",
            "联系人姐姐买过一张餐桌。",
            "联系人父亲收藏邮票。",
            "联系人给叔叔寄过明信片。",
            "联系人整理家族通讯录。",
            "联系人给母亲修过台灯。",
        ),
        "对伯父交谈的听力照顾相关，母亲口味和其他家庭琐事不是沟通条件。",
    ),
    Scenario(
        "hotel",
        (
            "联系人睡眠浅，住宿需要远离电梯的安静房间。",
            "联系人不接受吸烟房，住宿必须选择无烟房。",
        ),
        (
            "旅行替你订住处，房间环境和楼层位置有哪些要求？",
            "给你安排过夜的地方，怎样选才好休息且气味舒服？",
            "酒店订单我来填，特殊需求该写什么？",
        ),
        "睡眠浅住宿远离电梯要安静房间，不接受吸烟房需无烟房，怎么订？",
        (
            "联系人给同事订过吸烟房，自己没住。",
            "联系人朋友喜欢电梯边的房间。",
            "联系人保存过酒店大堂照片。",
            "联系人把旅行牙刷放在蓝色袋子里。",
            "联系人会查询酒店发票。",
            "联系人知道某酒店的前台电话。",
            "联系人整理过房卡套。",
            "联系人给家人买过行李锁。",
            "联系人曾翻译酒店菜单。",
            "联系人记录过附近景点地址。",
            "联系人给公司推荐过会议酒店。",
            "联系人看过酒店建筑纪录片。",
            "联系人家里有旧旅行标签。",
        ),
        "本人过夜的噪声与烟味要求相关，他人订单、景点和酒店宣传不适用。",
    ),
    Scenario(
        "birthday",
        (
            "联系人不喜欢生日惊喜，庆祝安排要提前告诉本人。",
            "联系人生日只想和几位熟悉朋友小范围聚会。",
        ),
        (
            "给你庆生，提前怎么沟通、邀请多少人比较合心意？",
            "想安排生日活动，通知和规模怎样定才不让你有压力？",
            "过生日我来张罗，你希望是怎样的组织方式？",
        ),
        "不喜欢生日惊喜要提前告诉本人，只与几位熟悉朋友小聚，怎么安排？",
        (
            "联系人姐姐喜欢惊喜派对。",
            "联系人给同事组织过大团建，不是本人的生日。",
            "联系人保存过生日蛋糕的包装照片。",
            "联系人把旧贺卡收进纸盒。",
            "联系人会设计电子邀请函。",
            "联系人知道气球店的位置。",
            "联系人帮朋友统计过活动人数。",
            "联系人家的蜡烛放在柜子里。",
            "联系人给家人转过宴会菜单。",
            "联系人整理过去年的礼品袋。",
            "联系人曾给社团借过音响。",
            "联系人收藏卡通贴纸。",
            "联系人记得朋友的生日月份。",
        ),
        "本人的知情和熟悉小圈聚会偏好相关；姐姐的惊喜与替别人组织活动不代表本人愿望。",
    ),
    Scenario(
        "video",
        (
            "联系人住处网络不稳定，视频通话经常卡顿。",
            "联系人希望通话前先发文字约时间，不要突然拨打。",
        ),
        (
            "想和你远程聊一会，怎么联系、提前怎样安排比较合适？",
            "晚上隔着屏幕见见你，怎样避开连接问题又不打扰？",
            "联系你聊近况，用什么形式、怎样开头约定时间更好？",
        ),
        "住处网络不稳定视频会卡顿，通话前要文字约时间不能突然拨打，怎么联系？",
        (
            "联系人同事喜欢突然打视频。",
            "联系人给朋友测试过直播设备。",
            "联系人手机壳是透明的。",
            "联系人家的路由器放在柜子上。",
            "联系人保存过通讯软件图标。",
            "联系人会整理电子通讯录。",
            "联系人帮家人换过充电线。",
            "联系人给公司做过远程会议背景图。",
            "联系人旧平板放在抽屉。",
            "联系人读过通信技术科普。",
            "联系人记录过维修店电话。",
            "联系人给姐姐选过手机挂绳。",
            "联系人整理过数字产品发票。",
        ),
        "本次与本人远程联络的连接限制和提前约定相关，他人习惯和硬件周边不决定联系方式。",
    ),
)


DEV_SCENARIOS = (
    Scenario(
        "garden",
        ("联系人种的薄荷需要见光。", "联系人种的薄荷土干后再浇水，不能天天浇。"),
        (
            "帮你照料阳台那盆香草，放哪里、多久补水？",
            "这几天植物交给我，光照和水分要怎么控制？",
            "代养你做饮料用的绿叶盆栽，有啥养护要求？",
        ),
        "薄荷要见光，土干后才浇水不能天天浇，怎样养护？",
        tuple(
            f"联系人整理园艺资料时记录了{item}。"
            for item in (
                "花盆底盘颜色",
                "邻居的仙人掌照片",
                "园艺店营业时间",
                "旧水壶容量",
                "花架的尺寸",
                "标签纸的价格",
                "园艺书出版年份",
                "朋友的兰花品种",
                "去年花展门票",
                "空花盆收纳位置",
                "铲子的手柄材料",
                "阳台窗帘尺寸",
                "园艺社通讯地址",
            )
        ),
        "当前照料薄荷的光照与浇水条件相关，其他园艺对象和周边无关。",
    ),
    Scenario(
        "photo",
        (
            "联系人拍鸟时希望保留距离，不惊扰动物。",
            "联系人拍鸟时会用长焦镜头，不使用闪光灯。",
        ),
        (
            "陪你去记录野生小动物，距离和器材怎么选？",
            "公园里有鸟想拍下来，怎样尊重它们又拍得清？",
            "跟你学拍羽毛小家伙，靠近程度和打光有啥要求？",
        ),
        "拍鸟保持距离不惊扰，用长焦不闪光，怎么拍？",
        tuple(
            f"联系人摄影笔记记录了{item}。"
            for item in (
                "相机包颜色",
                "室内人像背景纸",
                "朋友的闪光灯品牌",
                "相册封面尺寸",
                "展览开幕时间",
                "三脚架收纳位置",
                "旧相机购买年份",
                "打印店电话",
                "镜头布的价格",
                "摄影书封面设计",
                "证件照规格",
                "同事的合影编号",
                "胶卷盒收藏位置",
            )
        ),
        "野鸟拍摄的距离及器材相关，不混入人像、朋友器材或收纳信息。",
    ),
    Scenario(
        "museum",
        (
            "联系人看展喜欢先看文字说明再看作品。",
            "联系人看展不想赶场，一次只安排一个展馆。",
        ),
        (
            "陪你参观艺术展，阅读顺序和当天行程怎么安排？",
            "一起去看作品，怎样逛让你看得明白又不累？",
            "你来定参观节奏，导览和站点数量该怎么选？",
        ),
        "看展先文字说明再作品，一次只一个展馆不赶场，怎么安排？",
        tuple(
            f"联系人展览资料中记录了{item}。"
            for item in (
                "门票印刷颜色",
                "朋友的集章册",
                "展馆商店电话",
                "旧展览海报尺寸",
                "寄存柜编号规则",
                "同事的团体订票",
                "纪念袋收纳位置",
                "艺术书出版年份",
                "展览网站域名",
                "过去的闭馆通知",
                "包装纸材质",
                "明信片寄送记录",
                "展架维修联系人",
            )
        ),
        "本人参观顺序和节奏相关，展务与纪念周边不等于逛展方式。",
    ),
    Scenario(
        "chess",
        (
            "联系人学棋时希望复盘失败局。",
            "联系人学棋不喜欢被催落子，希望留足思考时间。",
        ),
        (
            "陪你练下棋，怎样处理输掉的对局和每一步的节奏？",
            "棋艺练习我来配合，怎么学错处又不让你着急？",
            "来一盘再一起分析，限时和回顾环节怎么定？",
        ),
        "学棋希望复盘失败局，不喜欢催落子要思考时间，怎么练习？",
        tuple(
            f"联系人棋类资料里记下了{item}。"
            for item in (
                "棋盘盒颜色",
                "朋友的比赛奖牌",
                "棋馆客服电话",
                "棋谱书出版年份",
                "棋子收纳袋尺寸",
                "同事的快棋报名",
                "棋社海报设计",
                "旧赛事座位号",
                "棋钟购买发票",
                "图书馆借阅规则",
                "棋桌维修记录",
                "会员卡有效年份",
                "纪念棋子包装材料",
            )
        ),
        "本人的复盘方式和思考节奏相关，他人快棋与棋具周边不代表本人节奏。",
    ),
    Scenario(
        "swim",
        (
            "联系人学游泳时害怕深水，先在浅水区练习。",
            "联系人下水前希望教练在场，不能独自练习。",
        ),
        (
            "陪你第一次练水中运动，在哪练、谁要在旁边？",
            "帮你安排泳池学习，怎么选区域和陪练保障？",
            "开始练漂浮了，水深和指导人员怎样安排才安心？",
        ),
        "学游泳怕深水先浅水区，下水教练在场不能独练，怎么安排？",
        tuple(
            f"联系人泳池资料中记录了{item}。"
            for item in (
                "泳帽颜色",
                "朋友的深水资格证",
                "更衣柜锁型号",
                "泳池商店电话",
                "旧泳镜发票",
                "同事的自由泳比赛",
                "海报印刷尺寸",
                "停车场入口",
                "毛巾收纳袋",
                "会籍卡片材料",
                "水质公告模板",
                "救生圈存放编号",
                "场馆建筑年份",
            )
        ),
        "初学本人的区域与教练在场限制相关，他人能力和泳池周边不构成安全授权。",
    ),
)


def build_dataset() -> SyntheticDataset:
    """按固定事实生成两个独立场景组；生成过程不读取评分结果。"""

    memories: list[SyntheticMemory] = []
    queries: list[SyntheticQuery] = []
    for split, scenarios in (("dev", DEV_SCENARIOS), ("final", FINAL_SCENARIOS)):
        scope = _scope(split)
        for scenario in scenarios:
            gold_ids = []
            for index, text in enumerate((*scenario.gold, *scenario.negatives)):
                memory_id = stable_id(f"{split}:{scenario.key}:memory:{index}")
                if index < 2:
                    gold_ids.append(memory_id)
                memories.append(
                    SyntheticMemory(
                        memory_id=memory_id,
                        scope=scope,
                        text=text,
                        role="gold" if index < 2 else "topic_negative",
                        source_ids=(
                            stable_id(f"{split}:{scenario.key}:source:{index}"),
                        ),
                        adoption_method="manual" if index % 4 == 0 else "auto",
                        category=(
                            "recent_state"
                            if index < 2
                            and scenario.key
                            in ("hiking", "exam", "move", "cook", "run", "hair")
                            else "preference"
                        ),
                        valid_at=(
                            datetime(2020, 1, 1, tzinfo=timezone.utc)
                            if index < 2
                            and scenario.key
                            in ("hiking", "exam", "move", "cook", "run", "hair")
                            else None
                        ),
                        invalid_at=(
                            datetime(2100, 1, 1, tzinfo=timezone.utc)
                            if index < 2
                            and scenario.key
                            in ("hiking", "exam", "move", "cook", "run", "hair")
                            else None
                        ),
                    )
                )
            for index, query in enumerate(scenario.paraphrases):
                queries.append(
                    SyntheticQuery(
                        f"{split}-{scenario.key}-paraphrase-{index + 1}",
                        split,
                        "paraphrase",
                        scope,
                        query,
                        tuple(gold_ids),
                        rationale=scenario.rationale,
                    )
                )
            queries.append(
                SyntheticQuery(
                    f"{split}-{scenario.key}-direct",
                    split,
                    "direct",
                    scope,
                    scenario.direct,
                    tuple(gold_ids),
                    rationale=scenario.rationale,
                )
            )
        for index, query in enumerate(
            ("谢谢啦", "收到", "哈哈哈", "晚安", "好的", "嗯嗯", "稍等", "👌", "……", "")
        ):
            # 空正文不能成为待回复消息，空字符组以标点表达无检索 token。
            queries.append(
                SyntheticQuery(
                    f"{split}-empty-{index + 1}",
                    split,
                    "empty",
                    scope,
                    query or "！！",
                    rationale="无任务语境，不应凭寒暄注入长期资料。",
                )
            )
    _add_auxiliary(memories, queries)
    queries = _complete_cross_topic_gold(queries)
    return SyntheticDataset(
        DATASET_ID, SEED, QUERY_TIMESTAMP, tuple(memories), tuple(queries)
    )


def _complete_cross_topic_gold(queries: list[SyntheticQuery]) -> list[SyntheticQuery]:
    """独立语义审查补全同 bank 跨主题约束，不读取任何检索器输出。"""

    from dataclasses import replace

    additions = {
        "coffee": ("meal:memory:0",),
        "meal": ("coffee:memory:1",),
        "run": ("hiking:memory:0", "hiking:memory:1"),
    }
    completed = []
    for query in queries:
        scenario = query.query_id.split("-")[1]
        extra = additions.get(scenario, ()) if query.split == "final" else ()
        if extra:
            query = replace(
                query,
                contact_gold=(
                    *query.contact_gold,
                    *(stable_id(f"final:{key}") for key in extra),
                ),
                rationale=query.rationale
                + " 同一 bank 语义审查："
                + {
                    "coffee": "饮品配料也必须避开花生过敏源，不能只按咖啡主题选 gold。",
                    "meal": "点餐也要考虑牛奶导致腹胀，饮品、甜点或配料可能含奶。",
                    "run": "本人膝盖恢复及平缓短路线/休息点要求同样影响跑步强度和路线。",
                }[scenario],
            )
        completed.append(query)
    return completed


def _add_auxiliary(
    memories: list[SyntheticMemory], queries: list[SyntheticQuery]
) -> None:
    scope = _scope("final")
    for index, query in enumerate(
        (
            "你同事喜欢什么口味的咖啡？",
            "那张影院地图放在哪？",
            "你爸收藏什么？",
            "你的旧工牌怎么收纳？",
            "你家厨房围裙是什么颜色？",
        )
    ):
        # 同主题负例组有自己明确的 gold；对主组的负例在另一个问题中可以相关。
        texts = (
            "联系人同事喜欢酸味咖啡，这不是联系人自己的口味。",
            "联系人保存了一张影院地图。",
            "联系人父亲收藏邮票。",
            "联系人旧工牌放在抽屉。",
            "联系人厨房围裙是黄色。",
        )
        matching = next(
            m for m in memories if m.scope == scope and m.text == texts[index]
        )
        queries.append(
            SyntheticQuery(
                f"final-topic-{index + 1}",
                "final",
                "topic",
                scope,
                query,
                (matching.memory_id,),
                rationale="问题明确询问周边或其他人物；这些资料在此问法下相关，不是永远排除的负例。",
            )
        )
    for suffix in ("other-contact", "other-owner"):
        other_scope = ContactScope(
            (
                scope.owner_id
                if suffix == "other-contact"
                else stable_id("isolation:other-owner")
            ),
            stable_id(f"isolation:{suffix}"),
        )
        for index, text in enumerate(FINAL_SCENARIOS[0].gold):
            memories.append(
                SyntheticMemory(
                    stable_id(f"isolation:{suffix}:{index}"),
                    other_scope,
                    text,
                    "scope_negative",
                    (stable_id(f"isolation:{suffix}:source:{index}"),),
                )
            )
    coffee_gold = tuple(
        m.memory_id
        for m in memories
        if m.scope == scope
        and m.role == "gold"
        and m.memory_id
        in (stable_id("final:coffee:memory:0"), stable_id("final:coffee:memory:1"))
    )
    queries.append(
        SyntheticQuery(
            "final-isolation",
            "final",
            "isolation",
            scope,
            FINAL_SCENARIOS[0].direct,
            coffee_gold,
            rationale="三位合成同名联系人正文相同；只允许当前已确认 owner/contact 的两个 ID。",
        )
    )
    for status in ("deleted", "invalidated", "expired", "future"):
        key = f"lifecycle:{status}"
        active_id = stable_id(f"{key}:active")
        text = f"联系人{status}资料组当前预约在周三，需提前文字确认。"
        memories.append(
            SyntheticMemory(
                active_id,
                scope,
                text,
                "lifecycle_gold",
                (stable_id(f"{key}:source-active"),),
            )
        )
        memories.append(
            SyntheticMemory(
                stable_id(f"{key}:excluded"),
                scope,
                f"联系人{status}资料组旧预约在周六，不需文字确认。",
                "state_negative",
                (stable_id(f"{key}:source-excluded"),),
                status=status if status in ("deleted", "invalidated") else "active",
                valid_at=(
                    datetime(2100, 1, 1, tzinfo=timezone.utc)
                    if status == "future"
                    else datetime(2000, 1, 1, tzinfo=timezone.utc)
                ),
                invalid_at=(
                    datetime(2001, 1, 1, tzinfo=timezone.utc)
                    if status == "expired"
                    else None
                ),
            )
        )
        queries.append(
            SyntheticQuery(
                f"final-{status}",
                "final",
                "lifecycle",
                scope,
                text,
                (active_id,),
                rationale="当前有效预约是正例；删除、失效、到期或未来记录必须拒绝。",
            )
        )
    for index in range(6):
        memory_id = stable_id(f"budget:contact:{index}")
        memories.append(
            SyntheticMemory(
                memory_id,
                scope,
                f"联系人预算压力组同意讨论第{index + 1}项活动细节。"
                + "这项安排只适用于本次活动。" * 9,
                "budget_gold",
                (stable_id(f"budget:source:{index}"),),
            )
        )
    queries.append(
        SyntheticQuery(
            "final-budget-contact",
            "final",
            "budget",
            scope,
            "联系人预算压力组同意讨论活动细节，这项安排只适用于本次活动。",
            tuple(stable_id(f"budget:contact:{i}") for i in range(6)),
            rationale="六条均相关且超过联系人条数和字符预算；只报告压力诊断，不进入主收益分母。",
        )
    )
    for index, text in enumerate(
        (
            "我平日不喝酒，聚餐不要替我点酒。",
            "我晚上要照顾孩子，不答应夜间聚餐。",
            "我吃素，聚餐不吃肉。",
            "我睡眠浅，聚餐后不想去很吵的酒吧。",
        )
    ):
        memories.append(
            SyntheticMemory(
                stable_id(f"owner:meal:{index}"),
                scope,
                text,
                "owner_gold",
                (stable_id(f"owner:source:{index}"),),
                layer="owner",
                adoption_method="manual",
            )
        )
    queries.append(
        SyntheticQuery(
            "final-owner-meal",
            "final",
            "owner",
            scope,
            "我吃素不喝酒，晚上照顾孩子，聚餐不能点酒吃肉也不能答应夜间聚餐。",
            owner_gold=tuple(stable_id(f"owner:meal:{i}") for i in range(3)),
            rationale="本人路径独立评价前三项饮食及晚间约束，不计入联系人 Recall@5。",
        )
    )
    queries.append(
        SyntheticQuery(
            "final-owner-budget",
            "final",
            "owner_budget",
            scope,
            "我聚餐不喝酒吃素不吃肉，晚上照顾孩子不去夜间聚餐，睡眠浅不去很吵的酒吧。",
            owner_gold=tuple(stable_id(f"owner:meal:{i}") for i in range(4)),
            rationale="四条本人约束均相关，超过本人三条预算；独立压力组。",
        )
    )


def _json_default(value: object) -> str:
    if isinstance(value, (UUID, datetime)):
        return str(value) if isinstance(value, UUID) else value.isoformat()
    raise TypeError(f"不支持的冻结字段类型：{type(value).__name__}")


def canonical_json(value: object) -> str:
    return (
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, indent=2, default=_json_default
        )
        + "\n"
    )


def dataset_documents(dataset: SyntheticDataset) -> dict[str, str]:
    """资料/问题与 gold 分开保存，摘要不依赖运行时间或召回结果。"""

    data = {
        "dataset_id": dataset.dataset_id,
        "seed": dataset.seed,
        "query_timestamp": dataset.query_timestamp,
        "memories": [asdict(m) for m in dataset.memories],
        "queries": [
            {
                k: v
                for k, v in asdict(q).items()
                if k not in ("contact_gold", "owner_gold", "rationale")
            }
            for q in dataset.queries
        ],
    }
    gold = {
        "dataset_id": dataset.dataset_id,
        "annotations": [
            {
                "query_id": q.query_id,
                "contact_gold": q.contact_gold,
                "owner_gold": q.owner_gold,
                "rationale": q.rationale,
            }
            for q in dataset.queries
        ],
    }
    files = {"dataset.json": canonical_json(data), "gold.json": canonical_json(gold)}
    manifest = {
        "dataset_id": dataset.dataset_id,
        "seed": dataset.seed,
        "sha256": {
            name: hashlib.sha256(content.encode()).hexdigest()
            for name, content in files.items()
        },
        "annotation_basis": "可用于回复的资料 ID；先标注后运行，不是真值标签。",
        "query_rule": "使用现有 build_query_tokens 的 NFKC/casefold/200字符头尾采样。",
        "contact_budget": {"count": 5, "chars": 600},
        "owner_budget": {"count": 3, "chars": 240},
    }
    return {**files, "dataset-manifest.json": canonical_json(manifest)}


def freeze_dataset(dataset: SyntheticDataset, directory: Path) -> None:
    """同版本只能写入相同冻结内容，避免实验后静默修改数据或 gold。"""

    validate_dataset(dataset)
    documents = dataset_documents(dataset)
    for name, content in documents.items():
        path = directory / name
        if path.exists() and path.read_text(encoding="utf-8") != content:
            raise ValueError("冻结内容已变化；请创建新数据版本并保留旧结果。")
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in documents.items():
        (directory / name).write_text(content, encoding="utf-8")


def validate_dataset(dataset: SyntheticDataset) -> None:
    """在运行前核对 ID、范围、当前性和主组 gold 的可容纳性。"""

    memories = {m.memory_id: m for m in dataset.memories}
    if len(memories) != len(dataset.memories):
        raise ValueError("资料 ID 不能重复。")
    if len({q.query_id for q in dataset.queries}) != len(dataset.queries):
        raise ValueError("query ID 不能重复。")
    for query in dataset.queries:
        if not query.text.strip():
            raise ValueError("当前正文不能为空。")
        for layer, gold in (
            ("contact", query.contact_gold),
            ("owner", query.owner_gold),
        ):
            if len(gold) != len(set(gold)):
                raise ValueError("gold ID 不能重复。")
            for memory_id in gold:
                spec = memories.get(memory_id)
                if (
                    spec is None
                    or spec.layer != layer
                    or spec.scope.owner_id != query.scope.owner_id
                    or (layer == "contact" and spec.scope != query.scope)
                ):
                    raise ValueError("gold 的资料层或范围无效。")
                if (
                    spec.status != "active"
                    or (
                        spec.valid_at is not None
                        and spec.valid_at > dataset.query_timestamp
                    )
                    or (
                        spec.invalid_at is not None
                        and spec.invalid_at <= dataset.query_timestamp
                    )
                ):
                    raise ValueError("gold 必须是名义评估时刻有效的资料。")
        if query.group == "paraphrase" and (
            len(query.contact_gold) > 5
            or sum(len(memories[m].text) for m in query.contact_gold) > 600
        ):
            raise ValueError("主改写组 gold 超出最终上下文预算。")
