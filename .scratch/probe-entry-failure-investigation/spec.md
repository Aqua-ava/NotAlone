# probe.test.mjs"仓库探针公开准备入口"既有失败的定性调查

Triage: ready-for-human
State: resolved

> 来源：任务 04 与 B1 简化的收口都定位到 `desktop/tests/helpers/probe.test.mjs` 的"仓库探针公开准备入口…"用例失败（`paths.syncProbePath` 为空，`''`），且该失败在 `6685e7d9c`（任务 04 期间）之前就存在；2026-11-07 用户批准另开小任务："先判断是测试过时还是真缺陷，再报我"。

## Goal

定性该失败：**测试过时**（断言的装配形态已被后续变化取代）还是**真缺陷**（启动装配路径存在真实问题）。产出诊断报告并停下等人裁决；**不写修复代码**（除非定性明确为"测试过时"且用户已在对话中批准修复——批准前一律不改）。

## 调查要求

1. **失败最小化复现**：单独跑该用例，记录完整错误与相关日志行（`cd desktop && node --test tests/helpers/probe.test.mjs`）。
2. **沿数据流读代码**：`paths.syncProbePath` 的赋值来源（`desktop/src/main/backend/config.ts` 的 resolveSyncProbePath 链）、manifest 的产生路径（desktop 的 prepare-probe 流程）、以及该用例断言的启动装配点；把"为什么为空"定位到具体某个分支/条件，`文件:行号` 级证据。
3. **历史对照**：`git log --format='%h %ad %s' --date=format:'%m-%d %H:%M' -- <相关文件>` 对照该用例最后通过的时间附近改动；用 `git log -S 'syncProbePath'` 找断言与赋值两端的引入点；判断"过时"或"缺陷"的定性必须引用具体提交或行为差异证据，不许猜。
4. **边界确认**：真实资源目录（`Resources/notalone-probe/`）在当前构建形态下是否仍被装配/存在（只读检查）；runtime-cache.test.mjs 同源用例是否通过（任务 04 记录其通过）。
5. **定性结论**：写"测试过时（应改为断言什么）"或"真缺陷（缺陷是什么、谁受影响、建议修复方向）"，连同不确定的部分如实列出。

## 产出与收口

- `docs/verification/probe-entry-failure-investigation-20261107.md`（中文；引用 `文件:行号`；不含私有路径外信息）。
- 任务单底部 `## Answer` 摘要定性结论；`Triage: ready-for-human`（等用户裁决）；`State: resolved`（调查完成即结案，修复另立任务）。
- 不修改 desktop/src；工作树保护清单（用户 5 文件）不得触碰；纯调查可不产生代码提交（只有报告与任务单文件，任务单是 gitignored）——若报告需要单独提交：`git add docs/... <报告>`、中文标题、无署名行、不 push、`check_public_history` issues=0。

## 常用命令

```bash
cd desktop && node --test tests/helpers/probe.test.mjs 2>&1 | tail -30
cd desktop && node --test tests/helpers/runtime-cache.test.mjs 2>&1 | tail -6
```

## 停止条件

- 需要修改 desktop/src 或测试才能继续诊断时，停下在报告里列出"需要的最小干预"待用户批准。
- 发现真实缺陷影响启动/分发时，报告优先（安全/发布相关先行）。

## Answer

**定性：测试过时，不是真缺陷。**

- 证据链：probe.test.mjs:88 断言的是 `52ab1a6f7`（10-30“退役旧PostgreSQL启动路径与手动文件导入入口”）之前的装配形态——当时 `StartupDiagnostics.getPaths`（desktop/src/main/startup/diagnostics.ts:30）向 `loadBackendConfiguration` 传资源目录并解析包内探针；该提交删去该参数，getPaths 语义收窄为“仅显式配置值”，包内解析整体上移到真实后台装配点 `desktop/src/main/backend/host.ts:281`（仍传资源目录）。测试文件自 `3f9c1e74d`（10-19）未再修改，未随装配迁移同步。
- 经验包围圈（/tmp 只读 worktree，已清理）：`52ab1a6f7^` 4/4 通过；`52ab1a6f7` 起与当前 HEAD 相同，行 88 实际 `''`。真实启动链完好：`process.ts:25` 仍注入 `NOTALONE_SYNC_PROBE`；runtime-cache.test.mjs 2/2 通过；当前 HEAD 上以真实 codesign 对 prepare 产物复核通过（两可执行 Identifier 匹配）。B1 简化（`99e891c84`）晚于失败起点一周以上，与此无关。
- 报告：docs/verification/probe-entry-failure-investigation-20261107.md（含过时断言清单：`:88/:149/:176/:201/:205/:215`；恒真失效的负面断言：`:115/:119/...`；修复方向二选一待裁决——断言迁移到 runner `probe` 字段，或产品上恢复 getPaths 报告包内解析）。
- 未改任何代码与测试；工作树保护文件未触碰。

## Comments
