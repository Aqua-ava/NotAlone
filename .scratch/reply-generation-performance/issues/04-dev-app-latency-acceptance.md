# 开发 App 延迟验收

Triage: ready-for-agent
State: resolved

Blocked by: 03

## Goal

复用 `pnpm run dev` 热更新实例，在相同联系人、相同合成输入和相同本地数据下比较修复前后的准备阶段，确认不再出现三十秒级等待。

## Acceptance

- [x] 只操作实际开发 App和微信，不打包、不发送外部消息。
- [x] 记录点击时间、本地阶段、模型阶段和总耗时，至少区分准备与模型。
- [x] 使用合成测试对象和输入，不保存私人截图、正文或凭据。
- [x] 报告实际样本量、前后耗时、数据影响、命令、剩余风险和清理情况。
- [x] 只提交本任务变更，不包含现有用户未提交修改。


## Answer

### 2026-11-04 首次实际 App 验收与阻塞

- 首次在隔离开发 App 的 92 个默认启用 Skill 下测得本地准备 24,211ms 与 24,053ms，点击到首次发送 24,344ms／24,910ms；模型等待仅 2,150ms／1,922ms。关系背景关闭样本本地准备仍为 24,051ms，排除聊天上下文造成根因。
- 查询层面通过：1,200 图片消息／6,936 次提取尝试的 `media.imageSyncTargets` P95 约 7.6ms；后台慢读 11/11 时不阻塞主写者。
- 根因是 Skill 预加载逐 Skill 调用整套运行复验：92 Skill 产生 17,296 次 `assertAnchor`，preload 本体约 20.6 秒；不是 SQLite 图片查询或模型网络。
- 修复后合成完整候选链路 92 Skill 三样本 P95/max 均为 593ms；真实 App 仍需在最终 HEAD 重验，ticket 在重验前保持 `claimed`，重验后改为 `resolved`。

## 2026-11-04 最终实际开发 App 验收（HEAD `416f4b7509e4532ccf30f64fe9fa2c4fff6651c9`）

### 环境与边界

- 复核 `git rev-parse HEAD` 为 `416f4b7509e4532ccf30f64fe9fa2c4fff6651c9`（`收紧候选分页响应边界`）；实际进程命令为 `desktop/.dev/app --notalone-dev`，不是打包 App，也没有运行 `pnpm start`。
- 新建隔离 userData 并导入同一合成联系人、3 条合成聊天和 92 个真实内置 Romance Skill；模型端为 `127.0.0.1` 合成 SSE 服务，延迟 1200ms。未读取真实微信/联系人资料，未向外部模型发送数据，未发送任何消息。
- 唯一桌面操作者；通过实际输入小窗完成点击、生成、历史讨论、关系背景开关和 Skill 详情加载。

### 实际 App 性能样本

同一联系人、空输入、关系背景开启，点击 `帮我想想`；时间取自实际点击事件与 SQLite：

| request_key | 点击→受理 | 本地整理 | 点击→发送 | 模型等待 | 点击→完成 |
|---|---:|---:|---:|---:|---:|
| `af6564cf-7f8c-43fc-8333-891e1e0ff223` | 3ms | 742ms | 745ms | 1,237ms | 2,154ms |
| `06bfc08b-06d1-4d76-9e4d-33e3d2007233` | 1ms | 686ms | 687ms | 1,211ms | 2,077ms |

- 本地整理 P95 = 742ms、max = 742ms，满足 P95 ≤1s / max ≤2s。
- 两次请求均各只有 1 条物理 `model_call`，均为 `committed`；各有 92 条 `skill_selection` 和 92 条 `skill_input`。
- UI 显示 `候选已保存，最终消息请自行发送。`，没有 `候选结果尚未确认`；UI 两条正文与 DB `reply_version_part.text_body` 完全一致。

### 候选窗口、状态与限制

- 6 个请求时：HTTP 200、165,214 bytes、`hasMoreRequests=false`、无截断提示、页面可读。
- 21 个请求时：HTTP 200、553,393 bytes（<2,000,000）、`requests=20`、`hasMoreRequests=true`，保留最新 20 条；UI 显示 `仅显示最近20次候选请求；更早记录未加载。`，20 个候选组、40 个候选编辑区，无候选错误，UI 正文与页面 API 完全一致。
- `GET .../reply-candidates/status?request_key=...` 对最终成功请求返回 HTTP 200，状态为 `committed`、`sent=true`；不再出现此前 allowlist 导致的 HTTP 400。
- 候选页不含 Skill 正文（`loadedSkills[].text` 为 0），只含身份元数据；21 请求页合计 1,840 条 Skill 身份记录。
- 真实 92 个内置 Skill 的正文总大小未触发 1.5MB 详情页上限：打开 `实际进入模型输入的 Skill 内容` 后一次加载 92 条正文，名称、版本、`SKILL.md` 路径和正文可见，无“加载更多”按钮。
- 加载 Skill 详情前后 `model_call=5`、合成模型日志 10 行、最新请求 `skill_input=92` 均不变，证明展开正文不会触发模型调用。
- 正向的详情分页（`nextOffset` 后继续 `?offset=` 并拼接为 `total`）由 `sqlite-reply-skill-loop.test.mjs` 的“92个Skill的三次候选页保持有限Skill身份并在详情按需加载正文”自动测试覆盖；实际默认数据没有自然进入第二页，未用伪造超大正文冒充实际跨页证据。

### 讨论历史与继续

- 操作前 `reply_request=5`、`model_call=5`、模型日志 10 行；新建讨论 `aac0cce0-bd27-42ba-9790-68fd4b356da3` 后，旧讨论 `71616c44-ed10-4898-985f-c788326614a0` 显示为“历史讨论 · 仅回看”。
- 点击 `继续此讨论` 后旧讨论恢复为 current，新讨论成为历史；请求数、模型调用数和模型日志行数均未变化，没有自动生成候选。

### 消息排除退役与关系背景

- 最近聊天区域显示 3 条消息、0 个复选框、0 个排除/恢复按钮；页面和请求中都无 `excludedMessageIds` / `excluded_message_ids`。
- 关系背景开启请求 `af6564cf...` 的实际模型输入含 3 条合成聊天，标记 `关系背景：已启用`。
- 关闭关系背景后请求 `822087c0-7cf4-4ea5-a3dd-d02aa645a6cc`：实际模型输入不含聊天正文，标记 `关系背景：已关闭`；仍只有 1 条物理模型调用、92 条 `skill_input`/`skill_selection`，UI 正常显示已保存候选。

### 257 Skill 整体降级

- 在隔离拷贝的技能根加入 165 个合成 Skill，共 257 个；UI 显示 257 个场景，全部完成文件核验并作为默认启用项进入 eligible 集合。
- 生成请求 `2f488be6-d4f8-417c-aead-6143d450f295` 正常 `committed`，仅 1 条物理模型调用；执行事件为 `skill_unavailable`，没有 `skill_input` 或 `skill_selection`。
- 实际模型请求不含 `<skill_content>`；UI 对最新请求显示 `回复策略暂不可用`、不渲染 Skill 详情，候选正文仍可见且显示 `候选已保存，最终消息请自行发送。`，无候选读取错误。降级为受控的一次无 Skill 调用，不是静默截取部分 Skill。

### 自动验证与收尾

- 后端：`node --test --test-concurrency=1 --test-timeout=30000` 运行上述 7 个契约测试加 `sqlite-reply-page-budget.test.mjs`，39/39 通过。
- 桌面：`node --test --test-force-exit --test-concurrency=1 --test-timeout=30000` 运行候选桥、候选面板、讨论面板、工作区与生成指引测试，50/50 通过。`--test-force-exit` 用于规避测试进程遗留的 Playwright/Chrome 句柄；不加时断言已跑完但 `after` 清理挂起。
- 性能/回归：后台读取与图片同步线性化 15/15 通过；大联系人图片同步 P95 8.041ms。
- `backend-ts` 与 `desktop` 的 `pnpm run typecheck` 均通过；`git diff --check` 通过。
- 最终 `git status --short` 只有既有的 `desktop/src/renderer/SqliteMemoryManagementPanel.tsx` 与 `desktop/tests/sqlite-memory-management-view.test.mjs` 用户修改；未提交、未 push、未创建 PR。
- 剩余风险：真实 92 Skill 数据不足以自然复现详情第二页，实际 UI 只能证明首屏懒加载；跨页正向行为目前由自动测试覆盖。
- 干净空 `userData` 正常退出复核：`HEAD=416f4b7509e4532ccf30f64fe9fa2c4fff6651c9`，仅创建空目录 `/private/tmp/notalone-fresh-exit-416f4b750/run.Ag4PmF/user-data`，未复制数据库、配置或运行时文件；通过 `pnpm run dev --user-data-dir <空目录>` 启动。实际进程为 `desktop/.dev/app --notalone-dev --user-data-dir=...`，`dev:status` 返回 `{"mode":"development","pids":[39477]}`。
- 只通过普通 UI 执行 `Cmd+Q`；CUA 返回 `App quit`，后端日志从 `phase:"stopping"` 到 `phase:"stopped"` 约 230ms，无 `shutdown-failed`。随后 `dev:status` 为 `{"mode":"stopped","pids":[]}`，进程与监听均清零。该对照确认此前的停读失败来自复用旧运行时数据库的隔离夹具，不是 final HEAD 在干净 userData 上的产品缺陷。

- 2026-11-04 独立 Desktop Acceptance 复核：在另一全新空 `userData` 上通过 `pnpm run dev --user-data-dir <空目录>` 启动，实际宿主命令含 `--notalone-dev`；仅用普通 UI `Cmd+Q` 退出，日志为 `stopping → stopped`，随后 `dev:status` 为 `{"mode":"stopped","pids":[]}`，无 Electron、后端、监听器或 dev socket 残留。该复核确认上面的干净退出证据可复现。

### 最终可复跑验证命令

后端（`backend-ts/`，`PATH=/tmp/notalone-node/bin:$PATH`）：

```sh
node --test --test-concurrency=1 --test-timeout=120000 \
  test/sqlite-reply-candidate-input-regressions.test.mjs \
  test/sqlite-discussion-history-continue.test.mjs \
  test/sqlite-discussion-isolation-regressions.test.mjs \
  test/sqlite-discussion-deletion.test.mjs \
  test/discussion-deletion-scaling.test.mjs \
  test/sqlite-reply-workspace-exclusion-contract.test.mjs \
  test/sqlite-reply-page-budget.test.mjs \
  test/sqlite-reply-query-allowlist.test.mjs \
  test/sqlite-reply-skill-loop.test.mjs \
  test/sqlite-skill-precall.test.mjs \
  test/sqlite-reply-skill-precall-profile.test.mjs \
  test/sqlite-background-reads.test.mjs \
  test/sqlite-image-sync-linearization.test.mjs \
  test/sqlite-reply-preparation-latency.test.mjs
```

结果：73/73 通过；Skill 专项再经 `node test/run-current.mjs test/sqlite-reply-page-budget.test.mjs test/sqlite-reply-skill-loop.test.mjs` 验证 22/22 通过。

桌面（`desktop/`，`PATH=/tmp/notalone-node/bin:$PATH`）：

```sh
node --test --test-force-exit --test-concurrency=1 --test-timeout=30000 \
  tests/sqlite-reply-candidate-bridge.test.mjs \
  tests/sqlite-reply-candidates.test.mjs \
  tests/sqlite-discussion-panel.test.mjs \
  tests/assistant-history-layout.test.mjs \
  tests/reply-workspace.test.mjs \
  tests/workspace-message-adoption-client.test.mjs \
  tests/unified-workspace-view.test.mjs \
  tests/reply-generation-guidance.test.mjs
```

结果：69/69 通过；`pnpm run typecheck` 通过。后端 `pnpm run typecheck` 也通过。
