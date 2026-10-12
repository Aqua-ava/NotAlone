# 维度运行字段核查与日期槽红反馈（2026-10-13）

本片承接[原03票](../memory-accuracy-next/issues/03-per-dimension-rollout.md)、[ADR-036](../../architecture/adr/036-per-dimension-adoption-release.md)及[放行台账](../../docs/memory-adoption-dimension-release-ledger.md)。Root要求独立核运行字段，随后授权仓库外最小合成负控；真实App组合与新V桥源码冻结期间不改产品源码、schema、提示、Gold、ADR或业务库，不改0.7、风险白名单、语用门和默认空放行表。

## 当前真实观察及边界

memory_diagnosis明确允许的最小视图为`/private/tmp/notalone-memory-goal-20261013-ac04d687/runtime-fields-public-projection.json`，0600，SHA `0c3685eef7640d1f5c67f02e4bce7c44083ef9c0583ca194d30dbe17abecee75`。它只来自既有公开A01／technical T06，声明1候选、14字段均在、`_to_fact`成功，正文、来源ID和理由仅给存在布尔／数量；本片不读technical原raw、V或其他私有输出。

受控值为`speech_act=correction`、`assertion_status=asserted`、两个日期槽明确null；因此维度键None符合原规则，不是mapper漏字段，也不证明指代运行键可推导。默认常量空表／gate=true仅为编译默认观察，不认证实际App进程是否载入运维回退。该视图不是完整生产写库／采纳回放，不给任何语义质量、用户确认或真实核心6/12签名。

## 生产字段来源与实际去向

[生产E schema](../../backend/src/notalone/memory_extraction/adapters.py:245)要求14字段；[mapper](../../backend/src/notalone/memory_extraction/flow.py:415)保留到[未落库ExtractedFact](../../backend/src/notalone/memory_extraction/models.py:90)。当前只有以下三个可达分支，优先级不能倒置：

| 键 | 必需判定字段与来源 | 当前条件 |
| --- | --- | --- |
| time | E返回valid_at／invalid_at，转为有时区datetime；原消息时间另用于来源／时效校验 | 任一日期非null，优先于其他标签 |
| subject | E受控subject、speech_act、assertion_status | 无日期且assertion＋asserted、subject为self或contact |
| truth_intent | 同上；FactSubject只有self／contact／shared | 无日期且assertion＋asserted、subject为shared |
| None | 标签或日期不满足上述分支 | 不获得任何维度放行资格 |

依据是[dimension_key](../../backend/src/notalone/memory_extraction/dimensions.py:91)，不是样本的评测dimension名字。改变样本标签、登记枚举或V=supported不能让Fact产生reference等新键；类别和主题也不是维度判定字段。字段存在与模型把字段填对分别验证。

| 原AC剩余类 | 原始信息哪里可用 | 当前typed缺口 |
| --- | --- | --- |
| paraphrase | 同联系人window含来源文字；V请求包含原消息及候选 | Fact只有正文及source_message_ids，没有保真判定所需的来源对齐／限定证据；通用supported不等于该维度质量认证 |
| reference | window正文可能含指代／引用线索 | E schema／Fact没有指代锚点、目标实体／消息及对齐关系；消息ID仅支持引用，不能替代指代目标 |
| media | NormalizedMessage已有message_type，实际写入message表；媒体占位与原文分开 | [消息loader](../../backend/src/notalone/memory_extraction/cli_support.py:71)不选typed message_type；MessageRef／Fact无类型字段，generic来源快照不是该门的类型投影。不是“全库没有媒体类型” |
| reported | E已有report／reported语用标签和source_message_ids，window已有sender | 没有独立被转述主体／转述来源关系；现规则不返回reported。不能把转述标签本身当可靠第三方身份 |

来源位置：[NormalizedMessage](../../backend/src/notalone/ingest/models.py:103)、[原消息实际写入](../../backend/src/notalone/persistence/postgres_repository.py:515)、[MessageRef构造](../../backend/src/notalone/memory_extraction/cli_support.py:153)、[E文字投影](../../backend/src/notalone/memory_extraction/adapters.py:309)、[V投影](../../backend/src/notalone/memory_extraction/verification_adapters.py:261)。不依昵称、正文特判或重新读未授权来源补这些字段。

三个键只在本轮Fact计算，并由[adoption_gates.dimension](../../backend/src/notalone/memory_extraction/adoption.py:295)记录key／gate／allowed／passed。候选持久化保留subject、日期、source_ids、confidence、风险、alternatives和简短reason；[MemoryCandidate](../../backend/src/notalone/memory/models.py:87)及[实际INSERT](../../backend/src/notalone/persistence/memory_store.py:127)没有独立speech_act、assertion_status、figurative_type或dimension列。完整Fact与原字段有独立可删除追踪，不等于候选表可直接重算所有键。原03的四类typed缺口仍在，不能用这张来源表勾AC1或改成resolved。

另有现行注释精度问题：[dimensions.py:35](../../backend/src/notalone/memory_extraction/dimensions.py:35)称reported“一律None”，实际时间规则先命中；[已有全标签时间测试](../../backend/tests/unit/memory_extraction/test_dimensions.py:131)也要求report／reported带日期返回time。无日期的reported才None；有日期也仍由[语用门](../../backend/src/notalone/memory_extraction/pragmatics.py:69)及[四道合取](../../backend/src/notalone/memory_extraction/adoption.py:637)阻止自动采纳。此片只记录，不改算法或放宽门。

## 实际最小合成负控：红，尚未修复

生产schema要求两个日期槽，但mapper的[两处payload.get](../../backend/src/notalone/memory_extraction/flow.py:438)把缺键静默当null。Root批准在Conda NotAlone运行独立30秒上限的私有结构探针，用新合成文字／固定UUID，不复制模型正文，不创建SDK或业务存储；静态AST读取原schema的required，不改原判据。

| 固定case | 实际parse／key／语用 | 预注册断言 |
| --- | --- | --- |
| 完整14、explicit-null、assertion／asserted | accepted／subject／confirmable；default allows=false | 通过，合法null保留 |
| 完整14、correction、explicit-null、合成歧义 | accepted／None／pending | 通过，区别于漏槽 |
| 完整14、report／reported、带日期 | accepted／time／pending；default allows=false | 通过，原优先级保留 |
| 缺valid_at | accepted／subject／confirmable，13字段 | 失败，必需槽应结构拒绝 |
| 缺invalid_at | accepted／subject／confirmable，13字段 | 失败，同上 |
| 两槽都缺 | accepted／subject／confirmable，12字段 | 失败，同上 |

一次进入测试：4方法／6case，3正控制通过、负控3个subcase失败、errors0，整体单调计时0.046751秒，exit1；unittest本体约0.001秒。默认放行仍关闭，因此只证结构漏槽可以误选subject，不宣称已观察坏auto或写库。真实HTTP／模型／App／存储写入／秘密读取0，socket／DNS及已安装HTTPX默认transport守卫尝试0。

首工具初始化因本环境缺非必要dotenv模块失败，尚未进入测试，不算产品红；原脚本／log保留。改为可用模块才补守卫、依赖socket／DNS硬拒与清空环境后，上述唯一实际红成立；未安装包，不删失败或无限重跑。私有目录0700，脚本／计划／结果／日志0600，进程已退出，无常驻资源；为了证据保留目录，不清除原失败。

证据目录：`/private/tmp/notalone-dimension-shape-20261013-QxqtyWgx/`。当前脚本SHA `382b421ac810f8798056d1f6ac2a9c5b56cff9a68357514f450414fb09167604`、plan SHA `3d71818dd3b07c95fe79006e0d706f188445fe90868ec9f1521e063a1b619f62`、result SHA `1b42c3260aae0a7b248bec4a0982f84bc43cb8a8c7d0c17d74ed361ce08080ec`；文件为`date_slots_probe.py`、`plan.json`、`result.json`、`red-output.log`及初始化失败v1两文件。只有合成结构结果，不上传或提交原输出／秘密。

最小修复候选：两处日期`get`改直接索引，缺键走现有Flow的structure_rejected；explicit-null仍合法。先在[公开Flow.run合成接缝](../../backend/tests/unit/memory_extraction/test_flow.py:333)新增“缺valid／invalid／两者必须拒绝”的真实红，保留完整字段null／时间／correction正控，再修两行并做最小Flow及维度回归。暂不修改源码；必须等Root App场次退出及V冻结 run闭账后协调，不使同场源码漂移。不得用此结构修复声称语义收益或恢复已关闭模型预算。

## 四类字段的最小可评审方案（仅准备）

所有新依据先限定本轮同owner＋contact、当前window的稳定message UUID／来源引用UUID，必要时带来源片段位置和正文摘要、window／candidate摘要；不赋新联系人ID，不复制聊天正文，不把模型标签标成已验证质量。未知、窗外、来源失效、歧义、正文或摘要变更均不可放行。

- 保真：来源片段／候选限定的对应关系及“可判定／未知”状态，必须能追溯到同窗口原消息；不能只加一个模型fidelity=true。
- 指代：锚点消息及片段、目标在窗内的消息／实体片段和不确定状态；实体仅是本窗口的来源锚，不建立第三方联系人或跨窗口实体库。
- 媒体：从实际规范消息投影受控message_type与“占位／已有文字”状态，不由正文猜类型，不新增OCR／转写能力。
- 转述：来源sender、被转述主体的窗内锚与直接／转述／未知关系；保持report／reported的pending规则，不因新类证据绕过语用CONFIRMABLE。

| 存放路线 | 可以复用什么 | 局限／需决定 |
| --- | --- | --- |
| 本轮typed Fact／source context＋现有trace JSONB | 追踪stage payload可记候选绑定的受限证据与规则版本，不需要为了审计新建DDL | 候选表没有此属性；trace目前是过程记录。将它用于资格推导需明确权威与失效规则、修订ADR-036；不能假装已实现持久候选字段 |
| 候选新增nullable dimension_evidence JSONB | 专属版本／依据对象，不混入risk_flags、alternatives或用户可见reason | 当前候选表无可复用通用JSONB；需要真实DDL、domain DTO／store投影、scope／source删除及兼容方案。旧候选null=unknown、不自动回填或重采纳，需要用户批准迁移范围 |

还需决定维度门的覆盖口径：当前单键time→subject→truth_intent优先，候选可能同时依赖主体、指代和保真。新增四类若继续单键，需明确优先与证据覆盖；若要求所有相关维度均放行，则改变ADR-036的单键接口，应单独评审，不能按优先规则掩盖未验证维度。两路线都保留现0.7／风险／语用门及默认空表；达到原≥15、假事0、记错人0、一般错误≤1和语义证据门后，才提交具体维度给用户逐类批准。

这些是可供集中决定的具体方案，不是新实现或架构批准。维持现三类、将四类留待另行ADR／迁移也可停止扩展，但原AC1仍未满足，不能据此完成整个原03。公开核心B两窗不能代替真实核心6/12；本片不读取真实核心材料，也不申请新模型、真实联系人或读取范围。

## 文档验证与评审

Conda NotAlone的标准库最小核查：22处本地文件／行号引用有效，三份私有合成证据SHA吻合，无行尾空白、有结束换行。首轮`git diff --no-index --check /dev/null`发现末尾多余空行（exit3），已删除并保留该失败记录；复核无输出，exit1仅表示新文件与空文件有差异。没有因此重跑产品或模型。

独立Standards由mac_provenance只读核本文、脚本／plan／result及关键源码，硬违反／Fowler判断气味／证据越界均0。独立Spec由memory_diagnosis只读核原03／ADR-036、许可projection、合成结果及六源对`6ca36359` blob，missing／scope／error均0。两轴没有运行测试、App或模型；主题独立本地提交按Root共享index调度执行。
