# Skill 单次模型调用预加载

> Triage: ready-for-human
> 日期：2026-11-04
> 状态：已实现；全部 tickets 已 resolved，独立审查和实际开发 App 验收已记录（2026-11-04）。
> 范围：正常 SQLite 候选回复的 Skill 装配；目标是把“模型先选 Skill、再生成”的两次物理模型调用，改为首次调用前预加载已启用 Skill，只调用一次模型完成候选生成。

## Problem Statement

当前正常候选回复走 DSH 的默认 Skill 机制：`@deepseek-ai/dsh-tool-skill` 自动发布 Skill 摘要目录，模型需要时调用 `skill` 工具加载正文，再生成最终候选。因此一次用户请求可能产生两次或更多物理模型调用。

实测本机 `@deepseek-ai/dsh-tool-skill@0.2.1-rc.2` 的安装制品与官方源码行为一致：

- 目录摘要自动进入会话；
- 正文不会自动加载；
- 模型明确调用 `skill` 工具后才取得正文；
- 没有“自动挑选并预加载正文”的默认开关。

NotAlone 已有显式 `selectedPackageId` 预加载路径，但没有正常入口的自动多 Skill 预加载。结果是当前正常回复虽然符合 DSH 默认机制，却多出一次模型选择和一次工具往返。用户明确希望：不增加逐次手选、不让模型先做一次选择，而是在第一次模型调用前把相关 Skill 直接放进上下文。

## Goals

1. 正常候选在未读取 Skill 资源时只产生一次物理模型调用；若模型读取受控资源，最多增加一次资源读取往返，并如实记录真实调用次数、原因和结果。
2. 不要求用户每次手选 Skill，也不改变联系人、输入、来源和删除边界。
3. 保持 DSH 官方 profile、provider、Agent 和 Tool 扩展机制，不改 DSH 核心、不分叉 DSH。
4. 只预加载 `enabled + verified + current revision` 的 Skill；停用、失效、缺失、冲突或修订变化的 Skill 绝不进入上下文。
5. 实际预加载的正文、修订、来源和请求仍可追踪、复验和删除。
6. 失败或预算不允许时，明确降级为无 Skill 的单次模型调用，不静默截断或带残缺 Skill 生成。

## Non-Goals

- 不改造 DSH 的官方 Skill 发现、Provider 或工具协议。
- 不增加用户逐次选择 Skill 的界面。
- 不引入向量召回、第二模型或本地分类模型来决定 Skill。
- 不改变旧助手讨论的存储、回看和删除策略；本规格只处理候选生成的 Skill 装配。
- 不改变关系记忆、场景文档、长期画像的抽取和预算。
- 不解决后台图片/记忆查询占用 SQLite 主队列导致的 30 秒卡顿；该问题另立规格。

## Proposed Solution

### 核心决定

**v1 正常回复预加载所有已启用、已核验、当前修订可用的 Skill 正文。**

理由：

- 用户已经通过“启用”表达了可用范围，不需要为每次回复再做一次 Skill 选择。
- 当前启用集合很小；先把“两次模型调用”收敛为“一次”，不额外引入本地相关性分类器。
- 模型仍可在一次调用内自行决定哪些 Skill 内容真正适用，但正文已经在上下文中，不再需要 `skill` 工具往返。
- 预加载失败时可以整体回退到无 Skill，行为边界明确。

后续当启用 Skill 数量或正文体积明显增长时，再评估本地相关性排序，不在本期引入。

### 目标请求流

```text
确认联系人、本次输入与工作区设置
  → 刷新并冻结 Skill 目录
  → 选出 enabled + verified + current 的 Skill
  → 校验每个 Skill anchor 与正文来源
  → 加载全部选中正文和必要身份信息
  → 将正文作为初始系统上下文
  → 不暴露 `skill` 目录加载工具
  → 一次模型调用生成候选
  → 复验实际输入、修订、来源和请求资格
  → 保存候选
```

### 具体行为

1. **预加载集合**
   - 取当前冻结目录中 `enabledState=enabled`、`verificationState=verified`、`currentRevisionNo` 非空且当前修订可用的全部 Skill。
   - 不按本次输入做二次筛选。
   - 没有符合条件的 Skill 时正常生成，只是不带 Skill。

2. **正文注入**
   - 在创建 Agent 前通过现有 Skill provider 读取每份 Skill 的当前正文。
   - 使用 DSH 官方 `renderSkillContent` 或等价受控渲染，将每份正文放进初始系统提示。
   - 不允许通过任意文件路径读取；资源仍只能通过已加载 Skill 的受控资源入口读取。

3. **工具可见性**
   - 预加载正常路径不再向模型暴露 `skill` 目录加载工具。
   - 保留 `skill_resource`，仅允许读取当前已预加载 Skill 声明的静态资源。
   - `skill_resource` 最多两次；如果模型确实读取资源，仍可能产生一次额外模型往返，这属于资源读取，不是 Skill 发现。
   - 如果产品要求“绝对只调用一次模型”，后续需要在预算内预加载所需资源或禁止资源工具；本期不把资源正文全量预加载作为默认。

4. **选择与已加载语义**
   - 预加载即为实际输入，不以模型是否调用工具判断。
   - 候选依据展示“本次预加载的 Skill”及版本；不宣称模型一定遵循了某份 Skill。
   - 现有“选择事件”扩展为可记录多个 anchor，并注明 `origin=auto_preload`、目录修订和触发原因。

5. **预算与降级**
   - 在任何模型发送前检查完整输入预算。
   - 若加入 Skill 正文导致完整请求超预算：
     - 不清截 Skill 正文；
     - 移除本轮全部 Skill 正文与资源目录；
     - 以无 Skill 单次模型调用继续；
     - 在候选中显示“回复策略暂不可用”，并记录预算原因。
   - Skill 读取失败、锚点失效、正文摘要变化或来源被删除时走同样整体降级，不保留部分 Skill。

6. **显式兼容入口**
   - 保留现有 `selectedPackageId` 单 Skill 显式预加载。
   - 正常自动入口与显式入口共用同一预加载、复验和记录链路。
   - 显式入口有优先级，不能被自动集合覆盖。

7. **DSH 官方边界**
   - 继续使用 `@deepseek-ai/dsh-skill` registry 与 NotAlone SQLite provider。
   - 不修改 `dsh-tool-skill` 安装制品。
   - 通过在 `setup` 中预先把正文加入 `systemPrompt`、并在 NotAlone 的 Tool guard 中隐藏 `skill` 工具实现。
   - 必须先验证：隐藏 `skill` 工具后，DSH 不再自动发布 Skill 摘要目录，不会额外诱导模型调用。

### 接口与数据影响

建议新增或调整以下内部接口：

1. `SkillPreloadPlan`
   - 输入：冻结后的 `SkillPackageState[]`、需求来源（自动/显式）、当前请求标识。
   - 输出：`SkillAnchor[]`、预加载来源、目录修订和降级原因。
   - v1 选择策略为“全部 eligible”，接口保留未来替换为相关性排序的能力。

2. `SqliteSkillRun`
   - 从单个 `selected` anchor 扩展为多个已预加载 anchor。
   - `selection` 保留兼容单值投影；新增完整预加载集合。
   - 每个 anchor 独立复验 revision、目录身份、正文摘要和来源。

3. `openSqliteSkillRun`
   - 增加多 anchor 预加载入口；保留 `selectedPackageId` 兼容。
   - 预加载正文失败时整体失败，不允许部分成功。

4. `installReplySkillTools`
   - 预加载正常路径不注册/不暴露 `skill` 加载工具。
   - 保留 `skill_resource` 和对应的精确 anchor 校验。
   - 记录实际资源读取，但不把资源目录本身当作正文输入。

5. 追踪与展示
   - 每个预加载 Skill 记录：package id、revision、head revision、manifest/content digest、目录修订、选择来源。
   - 实际正文和资源分别记录为输入。
   - 候选依据只引用真实进入请求的版本。

无需新增数据库表即可完成 v1；现有 Skill 目录与执行事件承载预加载身份。若现有事件载荷不足以区分多个自动预加载项，再增加最小迁移，不改变包和联系人隔离。

## Testing Decisions

### Seam 1：候选生成集成 seam

使用真实 `SqliteReplyTurns`、真实 SQLite Skill provider 和合成模型供应商，断言外部行为：

1. 一个已启用 Skill 时，第一次模型请求即包含完整 Skill 正文，且只有一次物理 `model_call`。
2. 多个已启用 Skill 时，全部正文进入第一次请求，且只有一次物理 `model_call`。
3. 首请求中不出现 `skill` 工具目录，不产生 `skill` 工具调用。
4. 没有已启用 Skill 时，仍只调用一次模型，且无 Skill 内容。
5. 停用、未核验、缺失或 revision 不一致的 Skill 不进入请求。
6. Skill 在准备后失效时，整体撤下所有 Skill 正文并降级为无 Skill，不留下部分内容。
7. 显式 `selectedPackageId` 兼容路径仍只预加载指定的单个 Skill。
8. 预算超限时不截正文，降级为无 Skill，并保留可诊断的预算原因。
9. `skill_resource` 仍只能读取已预加载 Skill 的资源，最多两次，不能串读同名路径。

### Seam 2：DSH profile seam

使用正式 profile 和实际安装的 DSH 包验证：

- 预加载路径不会再次发布可调用的 Skill 摘要目录；
- 预加载正文确实进入首次请求；
- 不修改 DSH 核心或安装制品；
- Agent 释放、取消和超时路径仍然完整。

### Seam 3：桌面候选展示 seam

- 用户不看到新的手选控件。
- 候选能列出本次实际预加载的 Skill 名称和版本。
- “预加载”不表述成“模型已经实际采用”。
- 降级时显示“回复策略暂不可用”，不把无 Skill 结果说成成功使用。

### 性能与行为对照

用同一份合成输入、同一模型替身和同一 Skill 目录比较修改前后：

- 修改前：目录注入 + `skill` 工具调用 + 最终生成。
- 修改后：预加载正文 + 一次最终生成。
- 记录物理模型调用次数、首次请求输入大小、总耗时和最终候选结构。
- 不以单次真实模型耗时作为质量证明；真实模型质量和桌面体验另行验收。

## Acceptance Criteria

1. 正常候选回复不再因 Skill 选择产生第二次模型调用；实现后以物理 `model_call` 数量验证。
2. 预加载集合与冻结目录、启用状态、验证状态和当前修订严格一致。
3. 任一 Skill 失效时不会带部分正文继续发送。
4. `skill_resource` 仍受已加载身份和两次上限约束。
5. 显式单 Skill 入口保持兼容。
6. 无 Skill 和预算降级路径都能正常生成候选，并显示真实状态。
7. 可通过现有追踪回答“本次带了哪些 Skill、哪个修订、正文是否实际进入请求”。
8. 不新增任意文件、跨联系人或外部发送能力。

## Rollout

1. 先实现多 anchor 预加载与集成测试，不切换正常入口。
2. 增加单次调用行为测试和预算/失效回归。
3. 切换正常入口到“全部 eligible 预加载”，保留显式入口和整体无 Skill 降级。
4. 用实际开发 App 生成一次合成候选，核对首请求、调用次数、依据展示和失败降级。
5. 若发现问题，回退到原有 DSH 目录 + `skill` 工具路径，不改变存储或删除语义。

## 已确认决定

1. 接受 v1“预加载全部已启用 Skill”的上下文成本；单轮 eligible 上限为 256，超限整体无 Skill 降级，不截取部分策略。
2. 保留受控 `skill_resource`，单轮最多读取两份声明资源，对应最多一次额外资源读取往返；发生资源读取时不宣称“绝对只有一次物理调用”，并记录真实次数、原因和结果。
3. 如果未来启用 Skill 明显增多，再单独评估“本地相关性 top-k 预加载”，不把该选择器塞入本期。
4. 旧助手讨论不进入新候选；回看与明确继续的边界由[新回复与旧助手讨论隔离](../new-reply-discussion-isolation/spec.md)约束。

## Implementation Tickets

以下 tickets 已于 2026-11-04 全部 `resolved`，实现、验证、独立审查和适用桌面验收证据见各自 Answer。

1. [`01-multi-skill-precall.md`](issues/01-multi-skill-precall.md)：把 SkillRun 从单 anchor 扩展为多 anchor 预加载，并保留显式单 Skill 兼容。
2. [`02-single-call-candidate.md`](issues/02-single-call-candidate.md)：正常候选入口改为预加载全部 eligible Skill，隐藏 `skill` 加载工具，只保留受控资源工具。
3. [`03-precall-trace-and-ui.md`](issues/03-precall-trace-and-ui.md)：记录多个预加载 anchor 的来源与版本，并校正候选依据展示。
4. [`04-precall-regression.md`](issues/04-precall-regression.md)：补齐单次模型调用、无 Skill、失效、预算和资源上限回归，并执行正式 profile 验证。
5. [`05-desktop-acceptance.md`](issues/05-desktop-acceptance.md)：在实际开发 App 中验证一次合成候选生成、依据展示和降级提示。

## Comments

- 2026-11-04：用户要求先出方案，暂不修改代码。已按规格创建 01～05 实现 tickets，均保持 `open`，未开始实现。

- 2026-11-04：实现、独立 Standards／Spec 审查与开发 App 验收完成；原“待用户确认”状态已由实际实施和验收取代。
