# 候选面板简化：请求分段、说法命名与版本降噪

基线：`main` @ `5b4728655`。文中 `文件:行号` 均为该基线，行号漂移后按引用的文字重新定位。
范围：**只改 SQLite 讨论路径下的候选面板展示**，不改数据结构、后端、IPC 契约，也不改“用户亲自发送”的产品边界。

## 1. 为什么要改

用户点“帮我想想”后，候选区出现“候选第 1 组 · 第 1 版”“候选第 2 组 · 第 1 版”……再点一次又出现新的“候选第 1 组 · 第 1 版”。用户分不清：

- “组”是什么，和“第几次”有什么区别；
- “版”为什么会有；
- 多次请求的结果混在一起，哪一批是最新的。

根因是数据层的四个层级被原样摊到了界面上，并且**请求这一层没有任何标识**。

## 2. 术语与数据层级（必须统一，不得再混用）

```
一次请求（reply_request）      = 用户点一次「帮我想想」/「帮我表达」
  └ 说法（reply_candidate）    = 一次请求里并列的 1~3 种备选，用户选其一；代码里 candidate_no
      └ 版本（reply_candidate_version） = 同一个说法的修改历史，版本 1 是模型原稿，之后每次「保存修改」追加一版
          └ 条（reply_version_part）    = 一个版本里要分几条消息发（多数是 1 条；保存修改最多 8 条）
```

要点（均已在代码中核实）：

- 版本只由**用户编辑**产生；重新生成产生的是新请求，不是新版本。`schema.ts:18-19` 约束：模型版固定为 `version_no=1`，手工版 `version_no>1` 且有父版本。
- 没改过的说法永远只有“第 1 版”。
- 选稿、“以此版本继续”都记录到具体版本，因此版本数据必须保留，**只降低界面存在感**。
- 界面此前把“说法”叫作“组”；同一概念在 `RewritePanel` 一路已叫“说法 N”。本次统一为**“说法”**。

## 3. 现状（SqliteReplyCandidatesPanel.tsx）

挂载路径：`index.tsx:112` 仅在 `discussionEntries===undefined` 时渲染 `UnifiedReplyWorkspace`；SQLite 路径下由 `AssistantSessionPanel.tsx:212` 渲染 `SqliteReplyCandidatesPanel`（区域名“表达工作区”，`:158`）。

| 行 | 现状 |
| --- | --- |
| `:186` | `hasMoreRequests` 时提示“仅显示最近20次候选请求” |
| `:187` | 每次请求一个 `<div className="sqlite-candidate-request">`，**没有标题，没有折叠，没有 CSS** |
| `:188-191` | 请求级提示：Skill 警告、结果未知、生成失败、来源失效 |
| `:192` | 说法卡片 `<article aria-label={`候选第N组`}>` |
| `:193` | 标题 `候选第N组 · 第M版（手工编辑）` |
| `:194` | 每条一个 `<textarea aria-label="候选第N条">`（N 为条序号） |
| `:195-199` | 按钮：保存修改、选用此版本、以此版本继续、查看上一版（版本>1）、回到最新版本（回看中） |
| `:200` | 依据 `<details>` |
| `:202` | “已记录N次选稿，最近选用第M版。” |

请求顺序：后端 `actions.ts:127` 取最近 N 条再按 `rowid` 升序，**页面里最旧的在上，最新的在最下**。

请求数据**不含时间和动作类型**：`shared/sqlite-reply-candidates.ts:14,80` 的读取器是严格字段白名单（`exact(r,[...])`），只有 `requestId / generationState / coverageWarning / skillWarning / sourceState / candidates / selections / loadedSkills / preloadedSkills`。因此本次标题**不显示时间和“想想/表达”**（见 §8 后续项）。

## 4. 目标与非目标

目标：

1. 每次请求有可辨认的标题，最新一次默认展开，更早的默认折叠成一行。
2. 说法统一叫“说法 N”，版本不进常规标题，只在“改过”或“正在回看旧版”时出现。
3. 保持所有现有能力：编辑、保存、选用、继续、回看、依据、失败/未知/失效提示。

非目标（不得顺手做）：

- 不改后端、schema、`shared/sqlite-reply-candidates.ts` 契约、主进程桥。
- 不改 `RewritePanel` / `CandidateVersionEditor` / `UnifiedReplyWorkspace`（旧路径，措辞“本组”“用这组回复新开会话”保持原样）。
- 不新增复制、发送或任何外部聊天能力；不改生成逻辑。

## 5. 设计决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 请求标题按**新旧倒数**命名：最新一次 = “最新一次”，其余 = “倒数第 K 次”（K 从 2 起） | 页面只含最近 20 次，`hasMoreRequests` 为真时按正序编号会错；倒数计数始终正确。 |
| D2 | 每次请求用一个 `<details>`，标题放 `<summary>`；**只有最新一次 `open`**，其余折叠；不再套外层“更早的 N 次”容器 | 用户反馈嵌套太多；扁平列表更简单。≤19 行折叠摘要可接受。 |
| D3 | 折叠摘要 = `标题 · N 个说法` + 状态后缀（见 §6） | 不展开也能判断这一批是否可用。 |
| D4 | **不新增“更多”折叠区**；“保存修改 / 选用这个说法 / 以这个说法继续”常驻，“查看上一版 / 回到最新版本”沿用现有条件（仅改过后出现） | 回看状态下必须有显而易见的出口；没改过的新卡片本来只有 3 个按钮，已经足够简单。**这是对此前口头方案的修订**。 |
| D5 | 卡片标题 = `说法 N`；`origin==='manual'` 追加“已修改”；正在回看非最新版时追加“正在回看第 M 版（非最新）” | 回看时“选用”选中的是旧版，用户必须知道自己看的是哪一版。 |
| D6 | 折叠不卸载内容：用 `<details>`，子树保持挂载 | `edits`、`inspected` 状态按 `candidateId` 保存，折叠不能丢未保存编辑。 |
| D7 | 折叠摘要必须标出“有未保存修改” | 用户可能在折叠状态下遗忘编辑中的内容。 |
| D8 | “条”的输入框 `aria-label="候选第N条"` **保持不变** | 大量测试依赖，且“条”语义正确；与“组/说法”无关。 |
| D9 | `selections` 文案“已记录N次选稿，最近选用第M版。”保持原样 | 这是选用记录的事实陈述，属于版本级信息，不在本次降噪范围。 |

## 6. 界面规格

### 6.1 请求区

```
（hasMoreRequests 时）仅显示最近20次候选请求；更早记录未加载。

▸ 倒数第 3 次 · 2 个说法                        ← 折叠
▸ 倒数第 2 次 · 3 个说法 · 已选用              ← 折叠
▾ 最新一次 · 3 个说法                           ← 展开
    [请求级提示：Skill 警告 / 结果未知 / 失败 / 来源失效，沿用现有文案]
    说法 1
      第1条 [textarea]
      第2条 [textarea]
      [保存修改] [选用这个说法] [以这个说法继续]
      ▸ 依据
    说法 2 · 已修改
      ……
      [← 查看上一版]（仅改过后出现）
    已记录1次选稿，最近选用第2版。
```

摘要后缀规则（按优先级只取一个主状态，再叠加附加标记）：

| 条件 | 摘要 |
| --- | --- |
| `generationState==='failed'` 且无候选 | `标题 · 生成失败` |
| `generationState==='unknown'` | `标题 · 结果未确认` |
| `sourceState==='unavailable'` | `标题 · 来源已失效` |
| `generationState==='running'` | `标题 · 生成中` |
| 其他 | `标题 · N 个说法` |
| 附加：`selections.length>0` | 追加 ` · 已选用` |
| 附加：该请求任一说法存在未保存编辑（`edits[candidateId]`） | 追加 ` · 有未保存修改` |

### 6.2 说法卡片

- `<article aria-label="说法N">`，`<h4>`：`说法 N` + 可选标记。
- 标记：`origin==='manual'` → ` · 已修改`；`v.versionNo!==candidate.versionNo`（正在回看）→ ` · 正在回看第 M 版（非最新）`。两者可同时出现。
- 按钮文案：`保存修改`（不变）、`选用这个说法`（原“选用此版本”）、`以这个说法继续`（原“以此版本继续”）、`查看上一版`（不变）、`回到最新版本`（不变）。
- 按钮的启用/禁用逻辑、`run()` 调用参数、`versionNo` 传递方式**全部不变**。

### 6.3 样式

`.sqlite-candidate-request` 目前没有任何 CSS。在 `helper-layout.css` 的 `.sqlite-discussion-details` 附近（`:186`）补：摘要字号/光标、请求之间的间距与分隔、标记文字次要色。只复用现有变量（如 `--panel-border`、`--panel-radius`），不引入新色值；窄窗口下不横向溢出。

## 7. 边界与易错点

1. `<details open={isLatest}>`：新请求追加后，原最新项应折叠；用户手动展开的旧项在无新请求时不得被刷新重置。需有测试覆盖“用户折叠最新项 → 刷新候选 → 仍保持折叠”。
2. 生成进行中（`progress` 状态）的提示在请求列表之外，不要改动。
3. 切换联系人/会话/范围失效时 `clear()` 清空页面，折叠状态随之重建，不需持久化。
4. 来源失效的请求（`:191`）正文已撤下，不得因折叠逻辑而显示或缓存正文。
5. `edits` 以 `candidateId` 为键，折叠/展开不得清除；`showPage(next, preserveEdits)` 的保留逻辑不改。
6. 无障碍：`<summary>` 可键盘操作；卡片 `aria-label` 用“说法N”，注意同页多次请求会出现重复的“说法1”，这是已知取舍，不在本次解决（测试按所在请求区域限定）。

## 8. 后续项（本次不做，不得夹带）

- **标题显示时间与动作（想想/表达）**：需要扩展请求读取契约，涉及 `shared/sqlite-reply-candidates.ts:14,80`、`backend-ts/src/reply/sqlite/candidates/actions.ts:127-133`、主进程桥 `desktop/src/main/reply/sqlite-reply-candidates.ts` 及后端测试。应另开任务。
- 旧路径 `RewritePanel` / `CandidateVersionEditor` 的“本组/这组”措辞统一。

## 9. 受影响文件

| 文件 | 改动 |
| --- | --- |
| `desktop/src/renderer/SqliteReplyCandidatesPanel.tsx` | 请求 `<details>` 与标题、摘要、卡片标题与按钮文案 |
| `desktop/src/renderer/helper-layout.css` | `.sqlite-candidate-request` 相关样式 |
| `desktop/tests/sqlite-reply-candidates.test.mjs` | 更新依赖旧文案的断言，新增折叠/标题/标记用例 |

不应出现在 diff 中：任何 `backend-ts/`、`desktop/src/main/`、`desktop/src/shared/` 文件。

## 10. 验证与验收

最小验证（由近及远，通过后再扩大）：

1. `cd desktop && pnpm run typecheck`
2. **本面板测试属 `headless` 分类，不是 `safe-node`**：`cd desktop && node --test tests/sqlite-reply-candidates.test.mjs`。该文件在 `desktop/tests/inventory.json` 中登记于 `headless`（真实 React + Playwright 无头 Chromium，启动本机 `/Applications/Google Chrome.app`），`desktop/pnpm test` 只跑 typecheck + `safe-node`，**不会执行它**；按 `desktop/tests/README.md` 的 headless 行先核对浏览器与夹具。基线（`6ff434fd1`，2026-11-06）实测 23/23 通过、退出 0。
3. 同面板邻近测试：`tests/sqlite-discussion-panel.test.mjs`、`tests/sqlite-discussion-composer.test.mjs`、`tests/sqlite-first-session-regression.test.mjs`
4. 真实界面：按 `AGENTS.md` 与 `docs/agents/engineering.md`“桌面验收”，复用 `pnpm run dev` 热更新实例，核对 §6 全部状态。构建通过不能替代视觉与交互验证。

真实界面必须看到：多次请求的标题与折叠、最新一次展开、改过后的“已修改”、回看旧版的提示与出口、折叠状态下的“有未保存修改”、窄窗口无溢出。

数据与隐私：不得向真实联系人发送消息；验收优先使用已有的多次请求历史或隔离测试数据，不为验收而对真实联系人触发新的模型调用，除非用户明确同意。本次不产生新的数据保存、日志或外部连接。

验收记录（2026-11-06，实现提交 `1ad6b5eaf`）：

- `cd desktop && pnpm run typecheck` 通过；`node --test tests/sqlite-reply-candidates.test.mjs` 30/30 通过；邻近 `sqlite-discussion-panel` 3/3、`sqlite-discussion-composer` 1/1、`sqlite-first-session-regression` 5/5 通过。
- 真实开发 App（复用 `pnpm run dev`，只读）：请求标题倒数计数、仅最新展开、旧请求折叠/展开、折叠刷新保持、421px 无横向溢出已核对。
- 真机缺口：开发库 `history_continuity_fence` 使有候选请求的联系人全部读为来源失效，卡片层状态（说法 N/按钮/依据/未保存修改）无正向证据；开发库 0 条 manual 版本，故“已修改/正在回看”也无真机证据，均由 headless 合成数据覆盖，不冒充真机验收。需真机卡片证据时应使用独立 user-data-dir + 预置有效来源夹具的隔离数据。

## 11. 工作区注意

工作区存在与本任务无关的未提交改动（如 `SqliteMemoryManagementPanel.tsx`、`backend-ts/src/history/...`、ADR 目录等）。只暂存并提交本任务文件，不得 `git add -A`；不 `git push`。
