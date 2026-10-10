# NotAlone 工作总览与下一步

更新日期：2026-10-11；原验收核对基点：`977bd93`；追加持续会话规格与六票发布记录。这是任务、代码入口及验收记录的现状盘点，不是重新执行全部测试的报告。原任务单保留权威状态；历史开发过程由原票与 Git 保存。

- [各功能的工作流入口](work-breakdown-20261011.md)：链接到对应目录的规划/媒体提案，区分已发布任务与待确认提案。
- [全部172张已发布任务索引](ticket-inventory-20261011.md)：逐票标题、状态与来源，包含已关闭和未关闭项。

## 当前结论

已发布任务共 **172 张**：`resolved` 160、`claimed` 4、`open` 8。其中5张已关闭任务标记 `wontfix`，另有实验判败、被替代的旧实现；因此160表示任务关闭数，不能等同于160项生产功能成功验收。Mac二十张任务中18张已关闭，18、20仍未关闭。

全部尚未收口工作仍归为 **13个入口**：6张既有未关闭任务、1份已发布六票的持续会话规格、2份新发布第一版规格（尚未切票）、2份后续草图、1份已确认但未切票的媒体规格、1个Windows后续方向。现在共12张未关闭任务；入口与任务有包含关系，不应重复相加。

**OCR依用户要求暂停。** 本轮盘点不启动App、微信读取、模型调用或部署；不会因完成文档就放行自动采纳或关闭原票。

## 已完成了什么

| 范围 | 已有交付与证据 | 完成的边界 |
| --- | --- | --- |
| Mac管理窗口与输入小窗 | [Mac任务索引](../mac-desktop-app/README.md)中的01–17、19已关闭：窗口、后端生命周期、诊断、首启、联系人、导入、改写、复制、明确方向回复、依据、资料查看/编辑/删除、授权、同步控制、消息事件与编辑保护 | 18/20未关闭；不能说完整Mac产品已验收。旧Swift主界面已退役 |
| 导入到回复的后端闭环 | [核心闭环](../core-business-flow/spec.md)、[导入自动处理](../import-memory-auto/spec.md)、[观察自动处理](../observation-memory-auto/spec.md)、[回复模块](../reply-module-flow/spec.md)的已发布任务已关闭；公开HTTP、正式PG/Worker、来源、幂等、恢复和删除有合成验收 | 脚本模型通过不等于真实模型质量通过，独立CLI入口也不代表App整合完成 |
| 记忆与可追踪依据 | 提取/来源核验、本人和联系人记忆、待确认候选、时效、追踪和删除链路已有实现；[追踪三票](../memory-extraction-trace/spec.md)已关闭 | 整体事实覆盖和指代质量仍未达标；[自动采纳放行表](../../docs/memory-adoption-dimension-release-ledger.md)仍为空 |
| 检索与Skill管理 | [词法召回](../memory-recall/spec.md)、[上下文/Skill](../memory-skill-context/spec.md)、[Skill库](../skill-library/spec.md)已有实现与原票验证 | 不把未上线的向量试验或新聊天策略算成产品能力 |
| 打包与部分原生能力 | [任务20](../mac-desktop-app/issues/20-mac-app-delivery.md)记录helper核验/随包、仓库探针构建、候选包签名、真实剪贴板、系统文件选择和合成导入；复制与桌面调度已结票 | WCDB精确构建/许可、最终Finder隔离启动、完整同步退出及OCR仍缺；历史候选包不自动代表最新代码包 |
| 真实微信单联系人同步 | [任务04](../native-app-backend/issues/04-real-wechat-follow-smoke.md)：新消息读取/入库/去重、故障自动恢复、关闭期间补齐、故障期间补齐均有实际记录 | 只覆盖已授权单联系人及记录中的测试条件，未覆盖双联系人和最终App退出 |
| 10分钟持续同步 | `977bd93`：Computer Use分时发送3条测试消息；后台运行601.5秒，120次采样均活跃，三条各入库一次，无重启，关闭零读取且临时资源清理 | 选定会话新增全局事件为0，消息由安全对账读取；不能称全局事件通知或小时级/高负载稳定性通过 |
| 研究、原型和官网 | [聊天路径原型](../conversation-paths-prototype/report.md)、[DSH探测](../dsh-session-probe/report.md)、Hindsight/pgvector对照已结束；[官网](../../website/README.md)已实现 | 实验结束可得“不采用”结论；聊天原型不等于新会话流程已接入产品，向量仍未默认启用 |

本轮最近完成的真实验收：`fde8c27` 当前全局流诊断与故障恢复；`8ce7fba` 正式线程复验和关闭期间补齐；`738f016` 故障窗口消息补齐；`977bd93` 10分钟分时发送与去重。`5613cff` 的空闲运行未覆盖新消息，仍作为独立历史结果保留。

## 六张既有未关闭任务：做到哪里、还缺什么

| 原任务 | 状态 | 已到的进度 | 尚缺 / 下一步 |
| --- | --- | --- | --- |
| [native-app-backend/04 真实微信follow](../native-app-backend/issues/04-real-wechat-follow-smoke.md) | claimed / ready-for-human | 单联系人实际读取、入库、去重、自动恢复、两类缺口补齐、10分钟分时同步已验证 | 对方来信的全局事件触发；双联系人独立游标和切回；最终App退出停读；视觉边界等OCR恢复后再验。后台持续同步通过不替代严格的follow事件条件 |
| [mac-desktop-app/18 前台定位](../mac-desktop-app/issues/18-foreground-locator.md) | claimed / ready-for-human；用户暂停 | 最小选区、多窗口极小辅助窗排除、安全失败分类已修；真实前台和采集路径越过前序门禁，名称完整与一致性通过 | 最低OCR置信度低于0.90，无verified profile；仍需定位采用/失效、焦点保护及宿主权限验证。**先不动，不降低门槛** |
| [mac-desktop-app/20 完整交付](../mac-desktop-app/issues/20-mac-app-delivery.md) | open / needs-info | 受控helper接线、正式候选包构建/签名、若干原生场景已通过 | WCDB Custom build精确来源/许可、与当前源码一致的最终包、Finder受控启动、快捷键隐藏确认、真实同步退出及原18依赖；不能继续写成“什么都没做” |
| [memory-core-claim-retention/01 核心事实](../memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md) | claimed / ready-for-human | 提示局部修正及多轮受控实验已记录；部分安全和保真检查通过 | 既有真实资料严格覆盖6/12、可选2/6，目标未达成；新预注册对照或目标范围决定。旧预算已关闭，不是缺凭据 |
| [memory-extraction-accuracy/07 指代](../memory-extraction-accuracy/issues/07-reference-resolution.md) | open / needs-info | 现行16条用例、门槛和保守去向已核对；110项确定性/追踪回归有记录 | 固定当前模型/配置与基线，针对实际失败修复，再评原门槛；需新对照与调用预算。历史13/15不能沿用为当前16条结果 |
| [memory-accuracy-next/03 维度放行](../memory-accuracy-next/issues/03-per-dimension-rollout.md) | claimed / ready-for-human | 空放行表、回退开关、工具计算门槛已实现；可推导subject/time/truth_intent | 其余维度缺结构化字段；既有评测未达标。先决定字段和质量路线，再取得可推导维度的达标证据及逐类批准；不自动放行 |

## 尚未完成的草图和规格

| 编号 | 材料 | 当前进度 | 未完成部分 / 接续点 |
| --- | --- | --- | --- |
| D1 | [持续会话与上下文管理](../../architecture/drafts/assistant-session-context.md) | 正式spec与六张任务已发布，均open | 从[01会话生命周期](../assistant-session-context/issues/01-session-lifecycle.md)开始，01→02→03→04→05→06；第一版不做自动摘要，不迁移框架 |
| D2 | [聊天回复策略](../../architecture/drafts/conversation-reply-strategy.md) | 第一版spec已发布，五票提案待确认 | 回应/主动、方向探索与消息组已收束；待确认[五票提案](../conversation-reply-strategy/ticket-proposal.md)，具体邀约Skill仍暂停 |
| D3 | [真实表达与关系感知](../../architecture/drafts/authentic-expression.md) | 第一版spec已发布，四票提案待确认 | 待确认[四票提案](../authentic-expression/ticket-proposal.md)；热梗、自动风格学习、长期影响研究仍后置 |
| D4 | [Agent编排与检索运行时](../../architecture/drafts/agent-runtime.md) | 部分既有运行时已落地，草案仍保留后续路线 | 在产品行为确定后核对真实差距；Harness不入当前主线，不把整份草案视为待重写 |
| D5 | [云端工程与认证设备](../../architecture/drafts/cloud-engineering.md) | 云端前置议题已列出 | 端云职责、认证/设备撤销、供应商、加密和删除；尚无直接部署授权或完整交付规格 |
| M | [微信媒体提取规格](../wechat-media-extraction/spec.md) | 需求已确认，未切正式实现票 | 联系人/消息到资源的唯一关联、缓存/删除、图片/视频、SILK→WAV、手动入口；**不包括ASR** |
| W | Windows微信适配 | [README](../../README.md)明确未实现 | 尚无可执行规格与任务，先确定平台范围与验证环境 |

不重复计入未完成草图：[召回一期](../../architecture/drafts/recall-phase-1.md)、[回复模块结构](../../architecture/drafts/reply-module-structure.md)、[官网视觉](../../architecture/drafts/website-visual-direction.md)已收束或转为历史参考；桌面A/B/C原型已有Mac规格以A为实现起点，不重新添加“选择样式”的阻塞。架构drawio是关系图，不是另一张未完成功能票。

## 哪些可以并行

| 工作线 | 现在可并行的内容 | 需要串行或等待的部分 |
| --- | --- | --- |
| A：Mac/真实同步 | WCDB来源材料核查、最终包隔离启动方案、既有证据整理可离线并行 | 所有真实App/微信/剪贴板/快捷键共用一台桌面，由主Agent串行验收；OCR暂停 |
| B：记忆质量 | 核心事实、指代、维度字段分别准备预注册/合成用例/契约审查，可与A并行 | 共享提示词/采纳代码的修改逐片合并；模型调用各自有独立预算，放行须在相应证据之后 |
| C：产品草图 | D1按已发布六票实施，D2可独立整理未决问题与既有原型证据；与A/B互不阻塞 | D1六票内部串行；D2与其共享契约有变更时需明确协调，不能覆盖已确认D1范围；D3复用其结果 |
| D：媒体 | 资源关联契约研究可独立于OCR和文字同步验收准备 | 先完成范围/缓存删除接缝，之后图片视频与语音可并行，最后集成 |
| E：条件触发扩展 | 云端/Windows范围材料可独立准备 | 当前无明确交付范围，不直接实现或部署；运行时扩展只在真实缺口出现时启动 |

并行是任务可独立推进，不是同时争用微信或同时修改同一份状态。已发布票优先；文档研究可以并行，但不会自动启动所有后续方向。

## 建议执行顺序

1. OCR继续暂停。先准备真实来信事件和第二联系人连续性的具体检查点；第二联系人尚未授权，真实来信需要对应测试输入。
2. 与上述准备并行核查WCDB来源和最终包的受控Finder/退出路径；不反复重跑已通过的签名与构建来冒充进展。
3. 记忆三票分别提交可审阅的新对照/字段方案；有新预算后才执行模型实验。
4. D1从已发布01票开始；D2/D3确认各自拆票提案；媒体按拆分方案确认后发布任务。
5. 最终完整Mac交付保留原18依赖；若要先交付“不含自动定位”的版本，需要另作范围决定，不能静默删掉原验收。

本次持续会话草图已完成设计收束、正式spec与六张任务发布，功能尚未实现。聊天策略与真实表达第一版spec已发布，分别五票/四票提案待确认；Agent运行时与云端仍在规划阶段，媒体四票仍是提案，见[工作流导航](work-breakdown-20261011.md)。本次正式新增6张open任务，既有任务状态未改，不宣称全局事件触发或完整App交付通过。
