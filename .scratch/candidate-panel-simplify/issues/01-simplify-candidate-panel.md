# 01：候选面板请求分段、说法命名与版本降噪

State: resolved
Triage: ready-for-agent
Blocked by: None (can start immediately)

## 规格与范围

[正式规格](../spec.md)。开始前先读 [Agent 工作流](../../../docs/agents/workflow.md)和[工程工作流](../../../docs/agents/engineering.md)，术语见 [CONTEXT.md](../../../CONTEXT.md)。本票只改 `SqliteReplyCandidatesPanel` 的展示，**不改后端、契约、主进程、旧路径渲染器**。

## What to build

用户点“帮我想想/帮我表达”后，候选区按请求分段：最新一次展开，更早的折叠成一行；卡片统一叫“说法 N”；版本只在“改过”或“正在回看旧版”时出现。能力与数据保持不变。

## 实现步骤

1. 读取 `desktop/src/renderer/SqliteReplyCandidatesPanel.tsx` 的 `:183-203`，并核对 spec §3 的现状表仍成立。
2. 请求容器 `:187`：改为 `<details className="sqlite-candidate-request" open={是否最新}>`。
   - 最新 = `page.requests` 的最后一项（后端按时间升序）。
   - `<summary>` 按 spec §5 D1、§6.1 生成：最新一次叫“最新一次”，其余“倒数第 K 次”（K 从 2 起）；追加摘要后缀与“已选用”“有未保存修改”。
   - 请求级提示（`:188-191`）移入 `<details>` 内容区，文案不改。
3. 卡片 `:192-193`：`aria-label` 改“说法N”；`<h4>` 改“说法 N”，按 spec §6.2 追加“已修改”和“正在回看第 M 版（非最新）”。移除常规标题里的“第M版”。
4. 按钮 `:196-197` 文案改为“选用这个说法”“以这个说法继续”；`保存修改`“查看上一版”“回到最新版本”文案不变；所有 `disabled` 条件与 `run()` 参数不变。
5. `:194` 条输入框 `aria-label="候选第N条"` **不改**。`:200` 依据、`:202` 选稿记录**不改**。
6. 在 `desktop/src/renderer/helper-layout.css`（`:186` 附近）补 `.sqlite-candidate-request` 样式，只用现有变量，窄窗口不溢出。
7. 更新测试 `desktop/tests/sqlite-reply-candidates.test.mjs`：
   - 旧文案：`选用此版本`（约 `:219`）、`以此版本继续`（约 `:44,57,62,235,274`）按新文案更新；`候选第N条` 不动。
   - 新增用例（合成数据，沿用该文件的 `panel()` 夹具）：
     a. 两个请求：标题为“倒数第 2 次”与“最新一次”，仅最新展开。
     b. `hasMoreRequests:true` 时标题仍按倒数计数。
     c. 保存修改后标题含“已修改”，不含“第2版”；回看上一版后含“正在回看第 1 版（非最新）”，且“回到最新版本”可用。
     d. 在折叠的旧请求里有未保存编辑：摘要含“有未保存修改”，展开后文本仍在。
     e. 用户折叠最新项后点“刷新候选”，仍保持折叠；新增请求追加后，原最新项折叠。
     f. 失败/未知/来源失效/生成中的请求摘要后缀正确，来源失效时不渲染正文。
8. 运行 spec §10 的验证阶梯；然后在真实开发 App 核对界面。

## Acceptance criteria

- [x] 同页多次请求有可区分的标题，且标题不依赖 `hasMoreRequests`。
- [x] 仅最新请求默认展开；旧请求折叠，不卸载内容、不丢未保存编辑。
- [x] 界面不再出现“候选第N组”；常规标题不出现“第M版”。
- [x] 改过的说法显示“已修改”；回看旧版显示“正在回看第 M 版（非最新）”并有“回到最新版本”出口。
- [x] 保存修改、选用、继续、回看、依据、选稿记录、各类失败/失效提示的行为与改动前一致。
- [x] diff 只含 spec §9 列出的三个文件；未触碰 `backend-ts/`、`desktop/src/main/`、`desktop/src/shared/`。
- [x] 未新增发送、复制、网络或数据保存路径；未向真实联系人发送任何消息。
- [x] 真实界面已核对 spec §10 所列状态；无法核对的写明原因，不以构建或单测代替。
- [x] 报告写明：数据处理影响（预期为无）、实际运行的命令及结果、剩余风险。

## 验证与交付

验证与桌面验收按 [工程工作流](../../../docs/agents/engineering.md)执行：先复用 `pnpm run dev` 热更新实例，不自行打包。验证后创建只含本任务文件的本地提交（不加 `Co-Authored-By` 署名行，不 `git push`）。工作区另有他人未提交改动，禁止 `git add -A`。

## Answer

结果：按 spec 完成请求分段、说法命名与版本降噪。本地提交 `1ad6b5eaf`，diff 仅 spec §9 的 3 个文件：`desktop/src/renderer/SqliteReplyCandidatesPanel.tsx`、`desktop/src/renderer/helper-layout.css`、`desktop/tests/sqlite-reply-candidates.test.mjs`；未触碰 `backend-ts/`、`desktop/src/main/`、`desktop/src/shared/`，未新增发送、复制、网络或数据保存路径，未向真实联系人发送任何消息。

改动：每次请求一个 `<details class="sqlite-candidate-request">`，最新一次默认展开、其余按“倒数第 K 次”折叠；摘要含主状态（生成失败/结果未确认/来源已失效/生成中/N 个说法）与“已选用/有未保存修改”；卡片统一“说法 N”，仅已修改或回看旧版时显示版本标记；按钮改为“选用这个说法/以这个说法继续”，其余禁用条件、run() 参数、依据与选稿记录不变；折叠不卸载内容，刷新保留用户手动状态；CSS 仅新增作用域规则并复用现有变量。

验证命令与结果（2026-11-06）：
1. `cd desktop && pnpm run typecheck` → exit 0。
2. `cd desktop && node --test tests/sqlite-reply-candidates.test.mjs` → 30/30 pass、exit 0。该文件登记为 `headless`（Playwright + 本机 Chrome），**不是 `safe-node`**；`desktop/pnpm test` 只跑 typecheck + safe-node，不覆盖此文件。
3. 邻近：`tests/sqlite-discussion-panel.test.mjs` 3/3、`tests/sqlite-discussion-composer.test.mjs` 1/1、`tests/sqlite-first-session-regression.test.mjs` 5/5，均 exit 0。
4. 真实界面（复用 `pnpm run dev` 实例；只读，未触发模型调用、未保存、未选用、未发送）：同一页 6 条请求标题可区分（`倒数第 6/5/4/2 次`、`倒数第 3 次 · 生成失败`、`最新一次 · 来源已失效`），仅最新一次默认展开，旧请求可展开；手动折叠最新项后点“刷新候选”仍保持折叠、手动展开项保持展开；窗口缩到 421px 无横向溢出；界面不再出现“候选第N组/第M版”旧文案。

真实界面缺口（数据状态限制，非代码失败）：开发库 277/280 联系人有 `history_continuity_fence`，含全部有候选请求的 3 位联系人，候选读取被判来源失效（正文与依据撤下），卡片层（说法 N、按钮、依据、未保存修改）在真机无正向证据；开发库 manual 版本 0、选稿 0，“已修改/正在回看”同样无法真机核对。上述卡片层状态由 headless 合成数据用例覆盖（真实 React + 无头 Chromium），不冒充真机验收。若需真机卡片证据，需独立 `--user-data-dir` + 预置有效来源夹具的隔离数据，列为后续项。

审查结论：Spec 轴 0 新增问题；Standards 轴 0 硬性违规、3 个非阻塞判断项（summary 缺 `:focus-visible` 与邻近既有模式一致；`requestTitle/requestOpen` 重复最新判定可后续抽 `isLatestRequest`；来源失效用例断言受读取契约限制，已加注释说明）。测试覆盖 issue 步骤 7a-f，并补充 §7.1 自动折叠守卫用例。

数据处理影响：无新增数据保存、日志或外部连接。剩余风险：真实界面卡片层未获正向证据；标题显示时间与动作仍按 spec §8 留作后续（需扩展请求读取契约）。

## Comments

- 2026-11-06 独立双轴审查（code-review）：Spec 轴 0 新增问题；Standards 轴 0 硬性违规、3 个非阻塞判断项（见 Answer）。按审查意见补充 §7.1 自动折叠守卫用例后 headless 30/30。
- 后续项（不在本票）：① 为 `.sqlite-candidate-request > summary` 补 `:focus-visible`（宜与邻近 `.sqlite-discussion-details > summary` 统一后一起做）；② 抽 `isLatestRequest(index,total)` 去掉 `requestTitle/requestOpen` 的重复最新判定；③ 真机卡片层验收需隔离数据（独立 `--user-data-dir` + 预置有效来源夹具）。
- 测试命令已核实：本面板测试归 `desktop/tests/inventory.json` 的 `headless`（Playwright + 本机 Chrome），用 `node --test tests/sqlite-reply-candidates.test.mjs` 运行；`pnpm test` 不覆盖它。
