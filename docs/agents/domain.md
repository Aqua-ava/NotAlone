# 领域文档

本仓库采用 single-context 布局；以下路径均相对仓库根目录，表中的规格路径相对 `architecture/`。

## 开始探索前

先读 [架构索引](../../architecture/README.md)，再按任务分支定位现行规格的相关章节。正文应直接说明适用要求，默认在 `architecture/current/` 和相关实现目录内检索；出现冲突、正文不足以解释边界或需要复审取舍时，再读取具体 ADR 的有效条款及替代提示。完整 ADR 目录、`architecture/history/`、`docs/history/`、草案归档、历史验收和旧任务仅在追溯时读取。完成条件：受影响的现行要求已核对，必要的来源疑问已消解，历史条款没有被当作新增要求。

| 任务分支 | 必读材料 |
| --- | --- |
| 联系人、消息、来源、记忆或检索 | `current/domain-data.md`；采纳再读 `current/memory-processing.md`，回复检索再读 `current/reply-generation.md` |
| 历史资料处理、记忆采纳或后台任务 | `current/memory-processing.md`；来源及删除另读 `current/privacy-deletion.md` |
| Mac 微信后台同步 | `current/wechat-sync.md` 的同步章节、`current/privacy-deletion.md` 的读取与删除边界 |
| 前台定位、OCR 或连续性 | `current/wechat-sync.md` 的前台识别与跟随章节、`current/privacy-deletion.md` 的视觉边界 |
| 隐私、外部模型或连接器 | `current/privacy-deletion.md` 及对应接入的相关 ADR |
| 本机交付、首启或资料更新 | `current/privacy-deletion.md` 的本机存储与生命周期、[桌面说明](../../desktop/README.md)；开发与发布门禁见工程工作流 |
| 回复、助手会话、Agent、Tool 或编排框架 | `current/reply-generation.md`、`current/privacy-deletion.md` 的运行记录与删除边界；当前实现入口见 [后台说明](../../backend-ts/README.md)，涉及 DSH 开发再读 [源码查证流程](dsh-development.md) |
| Skill 接入、发现、组合或生命周期 | `current/skill-library.md`；涉及 DSH 开发再读 [源码查证流程](dsh-development.md) |

草案仅在讨论其尚未决定的设计问题时读取；已收束草案的旧路径只提供现行入口和归档链接。复审旧框架选型时才读取 ADR-006／009／010 及运行时归档，不将旧实现步骤列为正常开发前置条件。

根目录 `CONTEXT.md` 存在时也要读取；缺失时继续任务，只在领域术语需要正式整理时使用 `domain-modeling` 创建。输出沿用其中已定义的名称；未定义的概念先判断是错误同义词，还是需通过 `domain-modeling` 补充的真实领域缺口。

云端工程已由用户于2026-10-29取消，产品按本机应用设计。模型供应商API的范围、凭据和资料出站仍按隐私分支核验。

## 记录路由

- 新的领域术语写入根目录 `CONTEXT.md`，不包含实现细节。
- 已采纳且当前实现必须遵守的规格写入 `architecture/current/`。
- 退出现行规格的旧协议与阶段实现记录写入 `architecture/history/`，被替代的工程操作与日期记录写入 `docs/history/`，均仅供明确的历史核对；现行条款在对应主题中直接说明，不以补丁堆栈表达。
- 尚未完全确认的实现设计写入 `architecture/drafts/`。
- 难以逆转、原因不显然且存在真实取舍的决定写入 `architecture/adr/`。
- 功能规格和代码整改按 [任务约定](issue-tracker.md) 写入 `.scratch/<feature-slug>/`；完成的评审过程由 Git 历史保存，不作为当前架构文档保留。

## 文档权威边界

- `AGENTS.md` 中的产品范围、隐私和人工发送约束是当前最高优先级规则。
- `architecture/` 是设计记录，不保证方案正确或已实现；已实现行为按根 `AGENTS.md` 的运行证据规则核验。
- 标记为“草案”的内容只用于理解探索方向，不得当作实现约束。
- ADR 已冻结为只读历史（见[决策与文档记录](workflow.md#决策与文档记录)）。其采纳记录说明当时的决定；当前约束须结合“部分替代／已替代”状态和具体适用范围判断。新证据表明仍有效的决定不合适时，明确提出复审，直接修改 `architecture/current/` 对应段落并写明原因；仅改变产品硬边界时才新增短 ADR。提议与有效 ADR 条款冲突时必须明确指出，不得静默覆盖：

> 与 ADR-XXX 冲突；重新讨论的原因是……

## 设计变更的文档收敛

- 确认设计变更时，检索同主题的现行规格、ADR、草案和相关任务引用；以明确采纳与替代范围判断有效性，文件日期或编号较新本身不构成替代。
- 改变设计时，直接修改 `architecture/current/` 对应段落，注明替代了哪些旧条款、保留哪些约束；不在旧 ADR 补回链，也不为此新建 ADR（产品硬边界变化除外）。同步阅读入口，草案标明后续正式入口。
- 已收束草案正文移入 `architecture/drafts/archive/`；仍被历史任务引用的旧路径可保留简短跳转页，先指向现行规格。架构首页只维护阅读路由，完整 ADR 目录和阶段验收记录按需访问。
- 决策状态、实现状态和验收证据分别记录；已采纳的目标不能写成已实现，历史测试也不能自动证明新方案可用。
- 完成条件：受影响的现行要求一致，现行规格注明被替代的旧条款，相关本地链接有效；无法从已确认决定消解的冲突列为待决问题，不静默选择一方。
