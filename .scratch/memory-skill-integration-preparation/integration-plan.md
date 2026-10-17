# 集成单元、接口适配与决策提案

> 本页保留首轮U1–U15提案与M1证据。用户已确认推荐方案；正式编号、已确认决策及当前状态统一见[spec.md](spec.md)、[planning.md](planning.md)。原U13现为正式10，后续原U10/U11/U12现为11/12/13，不能混用编号。

首轮提案时尚未发布实现票或分配执行者。B/M/S定义见[报告](report.md)。所有搬运都以固定S的最终行为为准；下列提交是定位锚点，不是可直接顺序重放的命令。

## 如何选择变更

在未来独立集成工作树从重新固定的main出发。每个单元保存：来源提交/路径清单、对应M行为、冲突处理说明、实际增量diff、验证结果。S新增且无耦合的模块可以按blob核对搬运；共享文件逐行为三方合并。不得整体替换 `server/app.py`、wiring、store、reply context/runtime、desktop session/index等装配文件。

历史领取、暂停、资源预约、文档签收提交不作为功能补丁逐条重放；其必要交付事实可作为验收引用。01原成果 `b02cf4ba` 在S中对应 `db83d794`；14原成果 `175c945b` 对应 `50766c06`。不能把外部原提交是否为S祖先当作有无交付的唯一判断。全部提交与父关系见[提交索引](commit-index.tsv)，全部路径见[文件索引](file-index.tsv)。

## 建议最小行为单元

每单元包括相应模型/port、应用、持久化、HTTP/桌面入口、来源删除及验证。不得先开放新写入，再留待末尾补删除。

| 单元 | 完整行为与主要模块 | 来源定位锚点 | 必要依赖／DDL |
| --- | --- | --- | --- |
| U1 历史核实 | 01：`memory/timing.py`、current_status及返回/证据/页面；保留未知时间与稳定事实差异 | `909ba6f2`→`db83d794`，交付`0eb82d26` | 无产品前置；新增字段必须兼容M固定上下文 |
| U2 纠错防复活 | 03：`memory/correction.py`、`persistence/memory_correction.py`、`correction_evidence.py`、提取/确认/人工纠错/擦除 | `ca3adb86`、`14893b7d`，交付`c0821fc4` | 业务独立；S058→提议059；完整旧证据及人工决定保护先于U3 |
| U3 事件与原子版本 | 02：`memory/events.py`、`persistence/memory_events.py`、version_evidence、pending语义键、撤销 | `f8159648`、`d17036b6`，交付`2b5e0a76` | U1；实际写入复用U2保护；S059→060；同时适配M Grounded事件协议 |
| U4 历史回复与明确继续 | 04：`reply_continuation_basis.py`、session/store/writer、依据变化提示与用户编辑 | `df1ee686`、`08bbb8e0`，交付`c0ae2c1a` | U1/U2；兼容M prepare/execute、退出与重试；不要求事件质量已放行 |
| U5 联系人概览 | 05：`memory/overview.py`、`persistence/memory_overview.py`、`relationship_overview_service.py`及页面 | `8afcb2c4`，交付`74c15496` | U1/U2/U3；S060→061；投影只存无正文manifest |
| U6 本人概览 | 06：本人scope、SELF来源、owner修订与同一投影管理 | `1f6e95b3`、`0509b08f`，交付`6b81d8b1` | 功能依赖U1/U2/U3；实现复用U5；S061→062 |
| U7 概览进入实际回复 | 07：`reply_overview_navigation.py`、检索计划/回执/预算、实际引用、原话补查 | `486d39f3`、`6ef16739`、`6007bac8`，交付`b4429b5c` | U5/U6；保留U4历史语义；无新DDL；固定上下文编解码/依赖与本单元一起验收 |
| U8 明确长期偏好 | 08：`expression_preferences.py`、`expression_preference_context.py`及明确用户动作、管理和删除 | 整合`32b6b722`、产品`84d13f70`、测试`86ce132e`，交付`562f85e4` | 业务独立；最终S实现共享U4/U7上下文，应逐块适配；S062→063；准备快照及隐藏联系人缓存同步清理 |
| U9 授权学习草稿 | 09：`application/skill_learning.py`、material/generation/store、Worker及审核待办 | `d0714a1f`、`798cac9b`，交付`e88a983e` | 业务独立；正式SQL前缀承接S062；S063→064；默认关闭，草稿不入运行目录 |
| U10 对照审核与发布 | 10：`application/skill_review.py`、review/navigation、隔离对照、批准范围与实际加载 | `2638a9f2`→`3cdc2117`，交付`aac75f16` | U9；DDL原S065→066，前面需先承接S064→065结构；对照不能临时发布试用 |
| U11 版本、合并与回滚 | 11：`persistence/skill_history.py`、版本来历/方法延续、历史入口 | `20615b85`、`fc3981d1`，交付`86481b98` | U10；S066→067；范围、完整来源、删除优先 |
| U12 方法与Skill范围反馈 | 12：执行投影、policy_revision、明确停用/撤销、当前回复/长期修订分开 | `84f547bc`、`30b5d558`、`527840a8`、`3985650f`，交付`20a84220` | 功能依赖U10，不与U11互相阻塞；SQL复合键实际依赖S066；S067→068；候选提交/恢复及资源加载复验 |
| U13 旧资料比较与应用 | 13：`application/memory_upgrade*.py`、store/apply/generation/traces、用户范围/总预算/批次 | `7af7e083`，交付`4b28f4c3` | 业务依赖U1/U2/U3；S064→065结构依赖U9的复合task键；先决定预览算法版本 |
| U14 语义研究归档 | 14：三份reports与“不启用”结论 | `50766c06`整合原研究 | 独立；不接生产装配、不阻塞其他单元 |
| U15 同源组合与签收 | 15：同一合成来源贯穿更新/纠错、概览、实际编辑选择、学习审核、停用、升级、删除 | 产品修正`342e63a8`、并发`c30a4051`、签收S | U4/U7/U8/U11/U12/U13；增加M×S反例；`342e63a8`中三处产品修正须归回对应单元，不能只搬最终测试 |

建议落地顺序为 U1→U2→U3→U4→U5→U6→U7→U8→U9→U13→U10→U11→U12→U15；U14独立。U4可在U1/U2就绪后与U3并行准备，U8/U9业务也可独立准备；此顺序主要减少共享文件反复冲突，不新增业务依赖。

选定canonical目录后的强制执行顺序为：M058 → U2(059) → U3(060) → U5(061) → U6(062) → U8(063) → U9(064) → U13结构(065) → U10(066) → U11(067) → U12(068)。相邻关系不都代表直接外键或业务依赖。如果U13产品后置，可以提前承接其真实DDL，但必须默认不启用对应工作入口、包含删除闭包和迁移验证；更简单的推荐是先完整U13再U10。不能仅凭原票Blocked by跳过连续SQL或结构父键。

## 共享接口的处理方案

| 交叉点与固定证据 | 处理要求与验收 |
| --- | --- |
| M `reply/prepared_context_codec.py:14,28,46,52–60` 严格类型白名单、完整字段集及version=1；S `reply/context.py:181,207,227`新增navigation/continuation_basis/retrieval/偏好 | 显式版本策略与新类型白名单一同实现；未知结构硬拒绝。旧回执不能静默丢字段、重取最新消息或给旧证明补值。验证保存、重启、重放和损坏格式 |
| M `persistence/assistant_prepared_context.py:48–92`只收集旧证据/样本/讨论；S `expression_preferences.py:147,157`、`reply_overview_navigation.py:41`增加使用关系 | prepare时实际C请求尚未建立，偏好及其来源、导航参与依赖必须立即加入擦除图；不能只在生成后记依赖。准备后删除、执行前删除、删除中迟到必须覆盖prepared_context JSON和隐藏缓存；此风险为静态推断 |
| S `assistant_session_store.py:137,261,402`区分合法历史及当前依赖；M prepare原统一验证 | 把历史/当前分组贯穿prepare与最终writer；来源仍合法的旧版本允许历史用途，当前新依据仍要求当前有效。不能全局放宽依赖门禁 |
| M `server/reply_wiring.py:100`外层PreparedAssistantContext；S同文件`:56,141`偏好与审核服务 | 保持main外层冻结，内部接入偏好/概览/审核；prepare无模型调用，审核对照仍是独立显式入口。M500条历史ID白名单与S剩余数量/字符预算同时生效 |
| M `server/command.py:284,303`及worker用Grounded；M `memory_extraction/grounded.py:233–245`未编译event；S `adapters.py:165–173,299`提出事件 | 保留M原文结构化默认，不让S旧wiring倒退。新增事件适配须逐字证据定位/独立核验，并保持质量门。event=None是安全退化，不是U3功能验收 |
| S `server/command.py:335`的build_upgrade_runtime使用LangChainExtractionRuntime | 明确升级算法版本、提示/协议指纹与预览快照；预览后算法变化使旧批准失效。不能把旧算法比较称为升级到新默认 |
| 双侧reply context/generator/runtime、retrieval、assistant_generation_lifecycle/session_store | 合并M generation_active/has_prepared_context/prepared_request、固定历史ID、异步许可；加入S历史提醒、预算、政策revision与来源复验。来源/人工决定/政策变化与writer使用同一事务锁边界 |
| 双侧desktop session/client/continuation/bridge/shared/preload/renderer | 保留M `await onPrepared`、联系人独立任务、退出凭证；补S scene/basisChanges/偏好回执/Skill执行范围，严格解析器同批更新。A→B→A及旧任务晚返回均核验 |
| M独有 `desktop/src/main/reply/contact-content.ts:10,22,33,108`不在40路径交集中 | 新字段仍需进入其缓存和恢复合同；补scene、basisChanges、偏好及隐藏联系人删除复验。路径交集不是全部语义影响范围 |
| 双侧 `desktop/src/main/index.ts`与server/app、command、worker | 以M持续跟随、顶部变化源、后台任务、同步与shutdown为底；增接学习/偏好/升级与删除。不得恢复S旧 `setReplyEditGuard` 或输入变化就撤销前台定位的接线 |
| S仅侧source_deletion/reply_cleanup/assistant_session_deletion/桌面删除协调 | 搬运时与M固定快照、缓存、后台任务归属共同验证；来源删除高于回滚、恢复及历史展示，不能漏掉只做上下文的参与来源 |

40路径完整名单见[shared-paths.tsv](shared-paths.tsv)。其余M独有prepared codec、prepare持久层、contact-content、generation jobs等同样进入接口验收。两侧 `backend/pyproject.toml`、desktop package/package-lock无差异；本方案不要求依赖升级。本轮未实现第三方API变更或查询外部文档。

## 待决定事项

下表保留首轮选项。后续已确认D1–D3推荐项，D4为保留S分叉库、当前不迁移清理，详见当前规格；实际合入main、访问业务资料或迁移仍需明确执行范围。

| 决策 | 建议选项 | 另一选项及代价 |
| --- | --- | --- |
| D1 canonical迁移历史 | 保留main001–058，追加本批059–068 | 保留S058–067、追加main prepared为068；改为main现存058库不兼容，仍不能同时无损覆盖两条账本 |
| D2 旧固定准备回执 | 集成编码显式升版；先沿既有generation/attempt事务核对终态或受控停止、封键及租约，再让旧回执明确失效并要求用户重新准备，保留已有编辑，不自动生成 | 实现v1→新格式显式解码/升级；必须区分未知新增字段与真实空值，证明来源/政策依赖完整，额外兼容工作较多 |
| D3 升级比较算法 | 使用main Grounded默认的明确版本，加有来源证据的事件适配；预览绑定完整算法指纹 | 保留S旧LangChain提取器作为显式命名的旧算法比较模式；不能宣称升级到main新算法，需要单独质量结论 |
| D4 S分叉数据库 | 先说明是否存在必须留存的S058–067数据库；若仅可丢弃合成库，另建canonical库验证，旧库待确认清理 | 必须留存则单独设计有备份恢复、原凭证保留及差异SQL的分叉审计接管；当前035 adoption不支持，禁止改账本伪装 |

D2还必须保留M `assistant_generation_lifecycle.py:130–150`的既有执行归属：运行中或终态未知的旧格式不能仅因codec过旧就丢弃旧任务、新建第二次生成或擅自解除租约；零C请求、已有C失败、封键与后台晚返回均须验证。D2和D3是实质兼容决策，其余逐字段合并、补删除依赖、保留main已完成行为属于集成必须完成的工程工作，不需要重新定义产品范围。D4未知不阻碍在新隔离合成库进行集成，但阻碍宣称既有S库可直接升级。

后续已按用户确认逐张发布正式票，统一State: open，尚未领取或实施。原U编号只用于来源映射；发布不包含push、PR、业务迁移或部署授权。

## 正式12签收后的当前前沿

12固定最终候选 `b2e4bf42e3e1cf118e55da7f232fe1c355820339` 经独立Standards／Spec最终复查均0新增／未关闭（原Standards P2 closed），无冲突合入 `1f3f711c0b017e8977d65cf429309c15e0b17511`，合并树与候选相同。六AC签收后，当前01–12、14共13 resolved、0 claimed、2 open（13／15），AC77／14；13仅逻辑就绪尚未领取。原117与修复24方法并集118保留分轮，30个已知created核销不补03／35／07／08旧unknown，旧页面两变化模块不追认新字节通过，详见[12集成记录](frontier-12-validation.md)。merger仅类型／静态与publication检查，无新动态资源；固定M2及S库保留边界不变。

## 正式13领取

2026-10-16：12最终候选 `b2e4bf42e3e1cf118e55da7f232fe1c355820339` 经独立Standards／Spec最终完整及增量复查均0新增／未关闭，原Standards P2 closed；无冲突合入 `1f3f711c0b017e8977d65cf429309c15e0b17511` 并签收 `608dd74786a4c45464d37f389fa721c248c7b96a` 后，领取真实就绪的13。canonical068依赖067提供的Skill复合键，按最小owner／contact／scene范围、独立policy_revision及真实正文／资源执行视图推进，保留普通意见只改当前回复、长期修订走待审与明确撤销才恢复。后续独立工作树实施，本集成根本次只记领取元数据，不写产品、不查询068或新建动态资源；六AC仍空，15继续受13阻塞。冻结M2、S分叉库保留、不合main与不动其他会话边界继续有效。

当前13 resolved（01–12、14）、1 claimed（13）、1 open（15），AC仍77／14。13六AC未勾，本次仅领取元数据，不代表068或方法政策已实现、验证或签收。


## 正式13签收后的当前前沿

2026-10-16：13固定修复候选`3a2ff9b2d7bcb93f48748666d855e13f02b6d2f7`经独立Standards／Spec最终完整及增量复查，原P2及重复投影判断项closed，新增／未关闭0；无冲突合入`762405952efad9f0da5aab56b64e4b84fcf4af09`，tree与候选相同。六AC签收，当前01–14共14 resolved、0 claimed、1 open（15），AC83／8；15仅就绪未领取。修复新30分2／27／1三轮，旧40交28并42，旧页面与纯组不追认新字节；新9加旧26共35个本票known-created核销不补旧unknown，详见[13集成记录](frontier-13-validation.md)。merger本树类型／静态合同与双publication通过，没有新动态资源。M2前58、原根前67及068固定S067原字节均核实，codec2／schema5，固定M2与S库保留边界不变；不合main或远端发布。


## 正式15领取

2026-10-16：13最终候选`3a2ff9b2d7bcb93f48748666d855e13f02b6d2f7`经独立完整及增量Standards／Spec复查均0新增／未关闭，无冲突合入`762405952efad9f0da5aab56b64e4b84fcf4af09`并签收`e1c73d93808da368f84297dcb557ae33216d2bb5`后，前置07／13均已resolved，领取真实就绪的15。后续在独立任务工作树实施同源组合、M2保护和最终分层验收；本集成根本轮仅记录领取，不运行PG／HTTP／Chrome／App／probe／CLI／模型或新租约，不创建任务工作树。15八AC仍空，原失败、分轮字节和旧unknown继续保留；M2冻结、S分叉库保留、不合main和不执行远端操作边界不变。

当前14 resolved（01–14）、1 claimed（15）、0 open，AC仍83／8；本次只领取15，不代表组合、原生或真实质量验收完成。
