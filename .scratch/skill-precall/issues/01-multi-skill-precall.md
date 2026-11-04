# 01 — 支持多 Skill 正文预加载与冻结复验

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 无

按 [spec](../spec.md) 把现有单 Skill 预加载链路扩展为多 Skill 预加载，同时保留显式单 Skill 兼容入口。本票只处理 Skill 运行域和 provider，不切换正常候选入口。

## What to build

- `SqliteSkillRun` 从单个 `selected` anchor 扩展为多个预加载 anchor；保留单值兼容投影。
- `openSqliteSkillRun` 增加多 anchor 预加载入口；现有 `selectedPackageId` 继续只选择指定单包。
- 每个 anchor 独立校验 package、revision、目录身份、manifest digest 和 content digest。
- 预加载正文全部成功后才进入运行；任一失败整体回滚，不允许部分 Skill 进入上下文。
- 每次选择/预加载记录来源、包身份、修订和目录快照；区分 `explicit` 与 `auto_preload`。
- 不影响现有禁用、未核验、失效、冲突和源目录变化时的拒绝路径。
- 不新增任意文件访问、跨联系人读取或外部发送能力。

## Acceptance Criteria

- [x] 能一次预加载一个或多个已启用且核验通过的 Skill。
- [x] 显式 `selectedPackageId` 仍只预加载指定单包。
- [x] 任一 anchor 失效时整轮预加载失败，不保留其他 Skill 正文。
- [x] 预加载集合和实际输入可追溯到精确 revision。
- [x] 联系人、owner、删除和迟到结果边界保持不变。
- [x] 现有 Skill、候选和删除回归不退化。

## Tests

- 单元/集成：`sqlite-skills.test.mjs` 增加多 anchor、单 anchor、失效 anchor 的测试。
- 候选集成：`sqlite-reply-skill-loop.test.mjs` 覆盖多 Skill 预加载并验证实际输入及来源。
- 运行 `backend-ts` 相关测试与 typecheck。
- 对照 `CONTEXT.md`、ADR-136 和 `architecture/current/skill-library.md` 复核术语。

## Out of Scope

- 不切换正常候选入口。
- 不决定启用 Skill 的自动排序策略。
- 不改桌面界面。
- 不处理旧助手讨论。
- 不修改 DSH 安装制品或核心源码。

## Answer

- 实现：`SqliteSkillRun` 增加多 anchor 预加载集合，以及 `preloadOrigin`／`preloadSelection`／`catalogRevision`／`preloadedSkills`；`selection` 保留显式入口或唯一预加载时的单值兼容投影。`planSkillPreload` 在冻结目录中只选 `enabled+verified+current`：显式 `selectedPackageId` 只选指定单包（origin=explicit，优先于自动集合），自动入口缺省选全部 eligible（origin=auto_preload），内部 `preloadPackageIds` 可限定集合。
- 入口与回滚：`openSqliteSkillRun` 第四参数为对象时进入多 anchor 预加载入口（等价导出 `openSqliteSkillPreload`）；逐 anchor 独立 `assertAnchor` 复验 package、revision、目录身份、manifest/content digest 后读取全部正文并写入选择事件和实际输入事件，全部成功才返回运行；任一校验、读取或记录失败即关闭运行且不保留部分正文，由调用方沿整体无 Skill 降级处理。旧位置参数 `selectedPackageId` 的单包按需加载语义保持不变。
- 追踪：每个 anchor 记录 package id、revision、head revision、directory identity、manifest digest、content digest；运行级记录 origin 与目录摘要。现有 `skill_selection`／`skill_input` 事件按 anchor 分别写入；事件载荷扩展 origin 留给票 03（其 What to build 明确包含事件载荷最小迁移）。
- TDD 证据：新增 `backend-ts/test/sqlite-skill-precall.test.mjs` 7 例。RED（实现前）`node --test test/sqlite-skill-precall.test.mjs` 为 1 通过／6 失败，失败原因是旧实现把对象参数当作 selectedPackageId 并报 `skill_selection_unavailable`；GREEN 7/7 通过，覆盖多 anchor 正文/精确修订/来源/目录快照可追溯且逐 anchor 写入事件、显式单包不被 preloadPackageIds 覆盖、旧位置参数兼容且不预读正文、失效 anchor 整轮失败无正文/选择残留并保持既有 pending 拒绝路径、停用/来源失效/缺失不进入集合、零 eligible 正常空预加载、不可用显式或预加载集合整体拒绝。
- 命令与结果（PATH=/tmp/notalone-node/bin）：`node --test test/sqlite-skill-precall.test.mjs` 7/7；`test/sqlite-skills.test.mjs` 27/27；9 个既有 skill 单测 76/76；3 个 DSH profile skill 测试 3/3；`node node_modules/typescript/bin/tsc --noEmit` 通过。`test/sqlite-reply-skill-loop.test.mjs` 在同步最新主线后为 15/15；分支早期曾因并行 isolation 未集成的冻结输入合同出现 13/14，该失败不属于本票实现，集成后已完整通过。
- DSH 依据：`backend-ts/package.json` 与 pnpm 锁声明 `@deepseek-ai/dsh-skill@0.2.1-rc.2`，实际安装同版本（路径 `backend-ts/node_modules/.pnpm/@deepseek-ai+dsh-skill@0.2.1-rc.2_…`），Cordis 4.0.5；安装制品 `exports['.']` 的 types 指向 `lib/types/index.d.ts`，其中 `SkillProvider`／`SkillProviderControl`／`registerProvider`（第166／188／247行）与本模块既有 provider 注册一致；本票未新增 DSH 接口调用、未修改 DSH 制品或核心，未新增任意文件、跨联系人读取或外部发送能力。
- 数据影响：只使用合成 Skill 包与临时目录，未读取真实资料、未启动桌面 App 或微信、未操作打包发布；Git 提交只包含本票路径。
- 剩余风险：①预加载失败后已写入的选择/输入事件依赖候选入口复用既有 `dropSkill` 整体降级清理（票 02 接线时必须复用，否则会留下无正文事件）；②origin 尚未落入执行事件载荷（票 03 负责最小迁移），当前由运行对象的 `preloadSelection` 承载；③新入口不对未进入本轮集合的其他包做额外磁盘复验，旧位置参数入口保持原全目录复验语义。

## Comments

- 2026-11-04：按规格创建，等待实现。
- 2026-11-04：实现与合成回归完成，等待独立 Standards／Spec 审查；当时保持 `claimed`，审查通过后改为 `resolved`。
