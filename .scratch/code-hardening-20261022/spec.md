# 全仓审查问题修复（A+B 范围）

## 用户问题

2026-10-22 用户要求按工作流程修复 2026-10-21 全仓审计中确认的 P1 逻辑问题、目录版 Skill 新代码问题、安全可删代码，以及两项产品决策。复核证据见 `.scratch/code-review-20261022/SUMMARY.md`（含旧报告修正，引用旧报告数字前先看第七节）。

## 已确认决定

1. **范围**：A1–A14 + B1–B2；结构重构（app.py 路由表化、session.ts 拆分）、评测/实验包迁移、仓库大文件清理、测试 CI/runner 门禁单独立 C 项 spec，不在本轮。
2. **记忆 UI（B1）**：接线。把版本历史、撤销自动更新、关系概览接回记忆页；保留 `readLayeredMemory` 投影中 `correctionTarget` 的既有依赖。
3. **维度门回退（B2）**：保留 `NOTALONE_MEMORY_DIMENSION_GATE` 环境变量，但它只关闭历史逐维白名单；`verified_sources` 来源核验永远生效。回退不再是「无核验自动采纳」后门。同步修订 README、ADR-036、放行台账，并按仓库要求新增说明性 ADR。

## Implementation Decisions

- 可观测性优先：异常必须进入日志或状态投影；日志与状态不得包含消息正文、文件真实路径、联系人可识别信息。
- 产品硬边界不变：不新增外部发送能力；不改变联系人隔离、删除、来源核验、人工发送边界。
- 修复以最小、可回归的改动为主；一次性大重构留给 C 项。
- 同一逻辑多份实现优先抽纯函数/单一来源常量，不借机做类拆分。
- 桌面容器与后端契约以后端为权威；错误码、reason、字符上限只在共享模块维护一份映射。
- 目录 Skill 的「运行前自动发现」语义保留，但读路径不得反复执行迁移/全目录写入；发现收敛到每轮/每次生成一次的显式入口。

## Testing Decisions

- 每张 ticket 走验证阶梯：单用例 → 相关模块 → 有界全量（`perl -e 'alarm 600; exec @ARGV' -- <命令>`）。
- Python 测试用 `unittest`，从 `backend/` 运行；桌面改动用 `cd desktop && npm run typecheck` + 相关 `node --test` / `npm test`。
- 修复类 ticket 先写失败回归测试再改代码；可观测性用 `assertLogs`/状态断言，不依赖真实 App。
- 真实 App/微信验收：桌面改动按工程工作流检查 `npm run dev` 现状；本轮以 typecheck + 自动测试为准，实际缺口如实报告。
- 每张 ticket 完成后回源码复核并跑相关模块；相关模块全绿才进入下一张。

## Out of Scope

- C1 评测/实验包边界与生产反向依赖解除。
- C2 `experiments/` 大 JSON、`.scratch` 证据日志、重复 logo 等仓库体积/证据清理。
- C3 `backend/src/notalone/server/app.py` 路由表化。
- C4 `desktop/src/main/reply/session.ts` 拆分、controller `publish()` 基类与 dispose 契约。
- C5 CI、测试 runner 覆盖、安全节点测试比例。
- 不 push / 不开 PR / 不打包 / 不发送任何外部消息。

## Tickets

| # | 文件 | 内容 | Blocked by |
|---|---|---|---|
| 01 | issues/01-backend-catchall-logging.md | 后端异常单点日志 | — |
| 02 | issues/02-sync-heartbeat-visibility.md | 同步心跳失败状态投影 | 01 |
| 03 | issues/03-import-deferred-visibility.md | 导入 deferred 可见 | 01 |
| 04 | issues/04-reply-evidence-degradation.md | 回复依据降级可见 | — |
| 05 | issues/05-desktop-first-frame-error.md | 首帧读取失败写 error | — |
| 06 | issues/06-async-preparation-cancel.md | 异步准备取消回收 | — |
| 07 | issues/07-contract-single-source.md | 契约单一来源 | — |
| 08 | issues/08-skill-read-path-write.md | Skill 读路径去写化 | — |
| 09 | issues/09-skill-cleanup-observability.md | Skill 清理失败可观测 | 08 |
| 10 | issues/10-skill-fs-error-path-defense.md | Skill FS 错误与路径防御 | 08 |
| 11 | issues/11-memory-read-batching.md | 记忆读取批量化 | — |
| 12 | issues/12-shared-context-validation.md | 共享上下文校验 | — |
| 13 | issues/13-memory-confirm-merge.md | confirm 事务合并 | 12 |
| 14 | issues/14-dead-code-removal.md | 安全死代码删除 | — |
| 15 | issues/15-memory-ui-wiring.md | 记忆 UI 接线 | — |
| 16 | issues/16-dimension-gate-semantics.md | 维度门回退语义 | — |

## 提交与记录

- 每张 ticket 一个本地提交；标题中文，正文 1、2、3、4 列改动/边界/验证。
- 不提交被忽略的调研、私密数据或本机产物；`.scratch` 任务文件按仓库约定可跟踪，但只提交本任务相关文件。
- 验证结果、数据影响和剩余风险写进提交正文与 issue 文件 Comments。
