# 29 项自主实现与集成结果

State: claimed
Triage: ready-for-agent

## 本轮范围与证据边界

本轮接续集成分支 `codex/autonomous-integration-29` 的 `84b5dd32`，处理 A 持续会话 07–18、B 聊天回复策略 01–11、C 真实表达 01–06 共 29 张原任务。原任务验收标准不删改，最终状态以各票实际完成范围为准。本文件是总协调结果索引，不替代原票或给人工验收补签。

用户已授权公开页面 → 生产具名 bridge → 后端 HTTP → 隔离 PostgreSQL 的自动验证。仅使用合成数据、可控模型和自有随机 `_test` 库；默认 dotenv 与外部追踪关闭。未授权范围为 OCR、真实微信、外部聊天发送、私人资料、付费或外部模型调用、push、发布、部署、额外用户会话及请求用户实施验收。

## 独立工作树与共享契约

| 组 | 本轮工作树 | 分支 | 职责 |
| --- | --- | --- | --- |
| A | `/private/tmp/notalone-round29-a` | `codex/round29-a` | 会话权威输入、连续修改、并发替换、消息提示、退出恢复与候选携入 |
| B | `/private/tmp/notalone-round29-b` | `codex/round29-b` | 两种聊天场景、方向探索生命周期、公开连续修改及策略组合 |
| C | `/private/tmp/notalone-round29-c` | `codex/round29-c` | 保真逐例报告、样本与来源删除、恢复及跨场景组合 |

三个子 Agent 接续已有成果。旧工作树仅作为只读交付参考，本轮不改写其在途源或创建用户会话。主树原有连续讨论代码复制到 A 树后继续验证，主树原件保留至正式净变更集成。后来收到用户既有 A 实现会话的正式交付，按原授权协调它只完成 A17 宿主退出、停止和显式重试净切片；它的工作树由该会话管理，Root 与三个子 Agent 不直接改写。A15 与两场景 typed 共用桌面消费者由 B 唯一接线，后台来源与迁移由 A 唯一接线。

当前生产迁移为 001–055：048 会话、049 样本、050 主动目的、051 输入版本、052 方向探索、053 候选版本、054 生成中断、055 候选携入。输入、版本和来源依赖只有既有业务存储一套权威；新增迁移须由总协调分配，不建立第二写入者或依赖图。所有迁移只在随机隔离库执行，不迁移业务资料。

普通页面测试按具名窗口串行运行，单实例无头 Chrome；源在执行期间冻结，退出后核对自有资源清理及独立租约状态。原生 Electron、微信读取、权限、剪贴板和真人模型语义不由页面或脚本替代。

## 起点状态核对

2026-10-11（台北）：原票 18 张为 `resolved`；A12–18、B09–11、C06 共 11 张仍为 `claimed` 或 `open`。这些状态是接续起点，不能当成本轮已经验收。已核对工作流、领域路由、ADR-042/043/044、现有迁移与主树未提交源；普通页面租约的只读状态为 `absent`。

## 原任务逐项索引

| 原任务 | 名称 | 接续起点 State | 已勾／未勾 AC | 原票证据 |
| --- | --- | --- | --- | --- |
| A07 | 默认会话的一次生成与可靠保存 | resolved | 6／0 | [原票证据](../assistant-session-context/issues/07-default-session-persistence.md#answer) |
| A08 | 重新连接后恢复已保存会话 | resolved | 5／0 | [原票证据](../assistant-session-context/issues/08-saved-session-recovery.md#answer) |
| A09 | 用户删除一段助手会话 | resolved | 6／0 | [原票证据](../assistant-session-context/issues/09-delete-assistant-session.md#answer) |
| A10 | 新开、列出与选择旧会话 | resolved | 5／0 | [原票证据](../assistant-session-context/issues/10-session-list-and-new.md#answer) |
| A11 | 候选编辑、选择与版本回看 | resolved | 6／0 | [原票证据](../assistant-session-context/issues/11-candidate-edit-history.md#answer) |
| A12 | 模型预算提醒与超限拒绝 | claimed | 0／6 | [原票证据](../assistant-session-context/issues/12-input-budget-guard.md#answer) |
| A13 | 连续要求、改口与明确编号指代 | claimed | 0／6 | [原票证据](../assistant-session-context/issues/13-continuous-intent-reference.md#answer) |
| A14 | 生成中替换请求与迟到结果失效 | claimed | 0／5 | [原票证据](../assistant-session-context/issues/14-replace-running-generation.md#answer) |
| A15 | 新消息提醒与用户触发重新生成 | open | 0／5 | 待本轮实际交付 |
| A16 | 切换会话或关闭小窗时保持生成归属 | claimed | 0／5 | [原票证据](../assistant-session-context/issues/16-background-result-ownership.md#answer) |
| A17 | 退出停止与重开后的中断恢复 | claimed | 0／5 | [原票证据](../assistant-session-context/issues/17-quit-and-interrupted-recovery.md#answer) |
| A18 | 显式携候选新开与满会话分流 | claimed | 0／5 | 待本轮实际交付 |
| B01 | 回应场景与明确意愿直达候选 | resolved | 6／0 | [原票证据](../conversation-reply-strategy/issues/01-response-scene-entry.md#answer) |
| B02 | 理解、纠正与方向确认闭环 | resolved | 6／0 | [原票证据](../conversation-reply-strategy/issues/02-understanding-and-direction.md#answer) |
| B03 | 换组、推荐与暂不回应 | resolved | 5／0 | [原票证据](../conversation-reply-strategy/issues/03-direction-options-and-pause.md#answer) |
| B04 | 明确目的的主动联系入口 | resolved | 5／0 | [原票证据](../conversation-reply-strategy/issues/04-proactive-purpose-entry.md#answer) |
| B05 | 主动目的探索与确认 | resolved | 5／0 | [原票证据](../conversation-reply-strategy/issues/05-purpose-exploration.md#answer) |
| B06 | 两种场景的关键澄清与取舍 | resolved | 6／0 | [原票证据](../conversation-reply-strategy/issues/06-clarification-and-tradeoffs.md#answer) |
| B07 | Skill探索、确认与生成的版本延续 | resolved | 7／0 | [原票证据](../conversation-reply-strategy/issues/07-skill-version-continuity.md#answer) |
| B08 | 候选消息组逐条编辑与复制 | resolved | 6／0 | [原票证据](../conversation-reply-strategy/issues/08-message-group-edit-copy.md#answer) |
| B09 | 未选方向时的新消息有界更新 | claimed | 0／6 | [原票证据](../conversation-reply-strategy/issues/09-bounded-direction-updates.md#answer) |
| B10 | 两种场景的连续修改与消息衔接 | open | 0／6 | 待本轮实际交付 |
| B11 | 策略全路径组合验收 | open | 0／5 | 待本轮实际交付 |
| C01 | 保真评测的离线逐例报告 | resolved | 7／0 | [原票证据](../authentic-expression/issues/01-offline-fidelity-report.md#answer) |
| C02 | 当前意图优先的生成与改写 | resolved | 5／0 | [原票证据](../authentic-expression/issues/02-current-intent-priority.md#answer) |
| C03 | 无依据扩写的约束与失败呈现 | resolved | 6／0 | [原票证据](../authentic-expression/issues/03-unsupported-content-boundary.md#answer) |
| C04 | 表达样本的主动保存、查看和删除 | resolved | 7／0 | [原票证据](../authentic-expression/issues/04-style-sample-lifecycle.md#answer) |
| C05 | 生成时有界引用表达样本 | resolved | 6／0 | [原票证据](../authentic-expression/issues/05-bounded-style-reference.md#answer) |
| C06 | 跨场景保真、样本与删除组合验收 | claimed | 4／3 | [原票证据](../authentic-expression/issues/06-combined-fidelity-acceptance.md#answer) |

## 逐项结果

待各组正式交付、独立 Standards/Spec 审查和主树集成验证后，逐项记录证据、提交、跳过理由与剩余工作。

### 已逐项集成的切片

| 切片 | 提供者提交 | 主树提交 | 主树实际验证 | 原任务状态与剩余 |
| --- | --- | --- | --- | --- |
| A13 正式续答与选定保存版本要求 | `0ec5a1ae` | `d41c1ff6` | 39 项真实 HTTP＋2 单元，共 41 项／46.998 秒；JsonClient 26 项／100.676 毫秒；完整 TypeScript；生产 001–055 全名账本、重复迁移 0、续答内层及外层自有库均剩余 0 | `claimed`；公开 typed 页面与生成生命周期继续接续 |
| C06 编辑、连续要求及样本／来源删除四场 | `70690d0a` | `af83e72d` | 4 项真实 HTTP／15.329 秒；12 次实际受控模型调用及输入捕获；Root 独立语义报告合同失败 0、故意语义失败 4、真人 0、质量未知；55／repeat0／内外库0 | 原语义分母保留，公开typed与生命周期继续 |
| C04／05 已实现状态文档校准 | `9e5ec225` | `9a15a9ca` | 27 个相对链接无缺失、diff通过；独立两轴无新增阻塞 | 不将设计文档当运行证据 |
| A13 同输入续答准备回执 | `dca102c8` | `06d18092` | 5 项真实 HTTP／5.140 秒；Node28／100.316ms；完整TypeScript；55／repeat0／库0 | 公共UI及退出未知准备仍继续 |
| B09 已确认方向候选的作业归属 | `59c4bd62` | `8e32480c` | Root八项真实Main/preload→HTTP→PG／29.278秒；TypeScript；八份55／repeat0／库0 | B具名公开八场另有实际记录；退出部分不借关闭 |
| C06 准备中断后样本／来源删除 | `969a8cba` | `dfb1c31c` | Root两项真实HTTP／3.721秒；55／repeat0／内外库0、compile／diff | 不增加原12例报告分母，不冒充宿主退出 |
| A17 重试原输入来源复验与依赖继承 | `7b2af9c4` | `a97e65f9` | Root两项真实HTTP／3.006秒；55／repeat0／库0；focused mypy／compile／diff；两实际反例由提供者先RED后G | 待删来源拒领取、复制随来源删除清理；宿主继续 |
| A12 warning具名页面与调度入口 | `6ad45edb`、`b9b5d360` | `81b5fea2` | 提供者具名单场实际Page通过（2模型、55／repeat0、自有清理、986源不变）；Root实际类型／双夹具编译／双入口bundle／npm test40项12.206秒、freshstatus absent | 只闭合warning，hard-limit及大历史继续；Electron未运行 |
| A17 可靠失败且无运行租约的实际退出终态 | `3fe38933` | `732d76c5` | Root完整生命周期10 HTTP／11.106秒；55／repeat0／内外库0；focused mypy／compile／diff，两轴无新增阻塞 | 宿主失败回包gate及运行中真实捕获来源闭包继续 |

A13 提供者实际复现 2 个 HTTP RED 后修复为 2 个 GREEN，保留未知要求必须明确确认的约束；独立 B Standards 与 C Spec 分别无新增问题。主树复验没有复用提供者测试计量。首次 PostgreSQL 与回环 Node 在沙箱内遭 socket `EPERM`，未当作产品 RED；改为已授权的本机测试范围后通过。第一次 Node 入口误用未安装的 `tsx`，已采用仓库已有 esbuild 编译方式，未安装依赖。

## 验证、提交与风险

待实际集成后填写；不把未执行的测试计作通过。
