# 05 任务 E：桌面真实验收（开发热更新实例）

Status: 已完成（覆盖度有缺口，见末尾）
时间：2026-11-06 21:14–21:44（Asia/Taipei）
本文只含现象、计数、原因码与截图路径，不含联系人姓名、聊天正文或可识别 ID。截图仅保留 UI 结构，均放仓库外 `/tmp`，未提交；裁剪后已核对不含姓名与正文。

## 0. 结论摘要

| 类别 | 结论 |
|---|---|
| CUA 实测（真实开发 App + 真实库，只读观察） | 记忆页可达；记忆自动处理为「已关闭」；选中联系人后「正式记忆 本页 5 条」与数据库 5 条一致，但 5/5 均显示「当前无可引用版本。」且只有「更多」，无「查看来源」；「待确认记忆」「处理中未完成记忆」两个候选分栏均未渲染（0 栏），页面从正式记忆直接到分页。未执行任何采纳/拒绝/撤销/保护操作。 |
| 自动化实测（合成夹具，真实 React 组件渲染） | 桌面管理视图套件 37/37 通过，含候选分组与原因码文案、来源/撤销可达性用例；后端裁决原因码套件 13/13 通过（含 `memory_relation_evidence_incomplete`、`memory_relation_inconsistent`）。 |
| 未覆盖 | 真实库上候选分栏、真实原因码文案、自动采纳记忆的来源/撤销入口均未能取得实测证据（原因见 §3）；撤销未在真实库执行；「范围变化/名单读取失败/绑定读取失败」三例属前台定位码，不在记忆管理页，未做真实前台故障场景。 |

## 1. 实例与环境核验（开发热更新，未打包）

- `cd desktop && pnpm run dev:status`（21:14）→ `{"mode":"development","pids":[93468]}`；（21:43）→ `{"mode":"development","pids":[98844]}`；（21:46 收尾复核）→ `{"mode":"development","pids":[4036]}`（并行任务保存源码再次触发热重启，非本任务操作），均为当前项目 `.dev/app` 的 `--notalone-dev` 宿主；监督器为 `node scripts/dev.mjs`（本轮后段 pid 96759，21:23 起，未变）。
- 打包版检查：`ps aux | grep '[N]otAlone.app/Contents/MacOS/NotAlone'` 计数 0，未发现打包版，未启动打包版。
- 未启动第二份 dev（复用现有监督器/实例）；未前台常驻运行 `pnpm run dev`。
- CUA 能力：`cua getCapabilities` → `accessibility=true`、`screenRecording=true`、`sessionLocked=false`，可用。
- 验收期间其他任务保存 `backend-ts/src` 触发开发监督器安全重启 3 次（electron pid 93468→94536→96778→98844，约 21:17/21:23/21:29），每次重启后窗口处于后台预载隐藏状态，均通过「窗口 → 管理后台」菜单项与 AX 重新打开，未强杀、未启动第二份。
- 焦点：CUA 为让窗口可操作做过 2 次 `activate`（21:31、21:34 前后），前台应用在当时从 Claude 切到 NotAlone；结束时前台已回到 DeepSeek Harness；未改变窗口尺寸和位置。

## 2. CUA 实测记录（对照 followup §6 E 检查项）

操作方式：macOS 辅助功能 AX 树（`AXPress`、`AXSetValue`）导航与选择，截图观察；未依赖坐标点击（一次坐标点击未生效即放弃，避免误击其他应用）。

1. 记忆页可达：侧栏「记忆」→ 标题「记忆」、副题「记住彼此的经历与偏好，让每次回应更贴近你们。」、区域「记忆自动处理 / 相处的点滴 / 记忆候选与版本 / 记忆处理状态」均出现。
2. 记忆自动处理状态：开关值「0（关闭）」，文案「已关闭：App 不会自动提取记忆，也不会为此调用模型。已有记忆仍可查看，并用于回复；新消息照常保存，开启后再统一处理。」→ 本轮不会触发生成或写库处理。
3. 选择联系人：顶部「本次联系人」组合框输入姓名后出现 1 条匹配，AXPress 选中；页面进入记忆列表。
4. 正式记忆：标题「正式记忆 本页 5 条」；5/5 张卡均为「聊天来源日期未知 · 当前无可引用版本。 · 更多」；「查看来源」控件数 0；「撤销…」入口数 0。与真库该范围 `memory.state='active'` 计数 5 一致（列表成员正确），但正文/来源不可引用。
5. 候选分组：页面中「待确认记忆」分栏 0 个、「处理中未完成记忆」分栏 0 个（`aria-label` 均未出现）；「正式记忆」之后直接是时间线说明「本页按已知聊天来源时间排列…」与分页「第 1 页 / 重新读取第一页」。即：本轮真实数据下分组未能渲染，不是分组位置错误。
6. 未执行的决定：未点击「采纳原稿 / 修改并采纳 / 拒绝候选 / 更多里的撤销或保护 / 开启自动处理」；未展开任何聊天来源正文；未新增真实资料。
7. 原因码文案：真库中没有可展示的候选卡，未能看到候选原因码文案（详见 §3、§5）。

截图（仓库外，已裁掉顶栏联系人选择框区域，无姓名/正文）：
- `/tmp/notalone-e-acceptance/p1-empty.png` — 记忆页空态（未选联系人）。
- `/tmp/notalone-e-acceptance/p2-memories-top-crop.png` — 记忆标题/自动处理关闭/相处点滴/正式记忆 本页 5 条/「当前无可引用版本」。
- `/tmp/notalone-e-acceptance/p3-memories-bottom-crop.png` — 列表尾部与分页「第 1 页」，正式记忆之后无候选分栏。

## 3. 真库只读计数与未渲染原因（`sqlite3 -readonly`，仅聚合）

- `memory_candidate`：`adopted` 85、`deleted` 2、`pending` 286（contact 69 / self 217）。
- 按 `read.ts` 的 `pendingDerivation` 口径派生：`decision_pending` 77（`memory_relation_pending` 76、`memory_duplicate_pending` 1）；`processing_incomplete` 209。
- `memory`：`active` 85；当前版本 `adoption_mode=auto` 85/85。
- `execution_event(kind=adjudication_result)` 的 reason 分布：空 85、`memory_relation_pending` 76、`memory_duplicate_pending` 1；**无**新拆分码 `memory_relation_conflict/evidence_incomplete/unsupported/inconsistent`。
- 来源资格阻断（推断 + 代码与计数）：`history_continuity_fence` 277 行、覆盖 277 位联系人，reason 全部 `history_source_continuity_unverified`；`history_guard_lease` 280 行；无围栏且有联系人文档/待确认候选的联系人仅 1 位，该联系人的 2 个 `conversation_binding` 状态均为 `revoked`（无 `verified`）。读取路径 `currentSourceScopeCTE` 要求 `state='verified'`，`assertSourceEligibility` 不通过即 `history_source_not_available`：`checkedVersion`/`summary` 使正文不可引用（显示「当前无可引用版本。」），`candidateView` 返回 null 使候选被读层丢弃。这解释了上述 5/5 不可引用与 0 候选分栏。**该原因属真库既有数据状态（围栏/绑定撤销，另有任务处理），不能据此判定本页实现缺陷。**
- 任务 E 期望的「按原因码显示候选」在真库上因此无对象可测；真库也无新拆分码数据。

## 4. 自动化实测（合成数据，区分于 CUA）

1. 桌面管理视图（真实 `SqliteMemoryManagementPanel` React 组件，headless Chromium + 合成桥）：
   `cd desktop && node --test tests/sqlite-memory-management-view.test.mjs`
   → `tests 37 / pass 37 / fail 0`（32.1s）。关键通过用例：
   - 「候选按处理状态分组：待确认显示原因文案，未完成候选标注处理中/未完成且不提供采纳入口」：`aria-label` 为「待确认记忆」「处理中未完成记忆」；待确认组含原因文案（`memory_relation_conflict` →「与旧资料构成真实矛盾，系统无法自行取舍，需要人工确认。」）；未完成组含「不需要逐条确认」且无「采纳原稿」。
   - 「首次记忆只展示当前内容，来源和修改可达且更多保留撤销」：`查看来源` 可展开，「更多」中「撤销首次自动采纳」可达，点击后经合成桥发出 `decide`（不写真实库）。
   - 「已采纳原稿按需从首次记忆历史读取…」：来源区块与折叠项可达。
   - 合成截图（工作树当前版本）：`/tmp/notalone-memory-timeline-preview.png`、`/tmp/notalone-memory-without-candidates.png`、`/tmp/notalone-memory-original-in-history.png`、`/tmp/notalone-management-pagination-preview.png`、`/tmp/notalone-flat-memory-preview.png`（另有 self/narrow 变体）。
2. 后端裁决原因码：`cd backend-ts && node --test test/sqlite-memory-adjudication-evidence.test.mjs` → `tests 13 / pass 13 / fail 0`（9.0s），其中断言 `memory_relation_evidence_incomplete`、`memory_relation_inconsistent`。
3. 原因码文案映射核验（代码级，非 UI）：`node` 导入 `desktop/src/shared/foreground-failure.mjs`，三条新拆分码均有中文：
   - `binding_scope_changed` →「联系人匹配｜会话绑定校验暂不可用（同步或新消息使微信范围刚发生变化，将自动重试）」
   - `binding_session_list_failed` →「联系人匹配｜会话绑定校验暂不可用（读取微信会话名单失败）」
   - `binding_verification_unavailable` →「联系人匹配｜会话绑定校验暂不可用（读取已绑定联系人失败）」
   **口径差异**：题面写的「范围变化/名单读取失败/绑定读取失败」是前台定位（绑定校验）原因码，不在记忆管理页；记忆页「新拆分的原因码」是 `memory_relation_conflict / evidence_incomplete / unsupported / inconsistent` 四码（`desktop/src/renderer/SqliteMemoryManagementPanel.tsx`）。旧码 `memory_relation_pending` 在界面走兜底文案「处理原因未知（<code>），可先查看来源或联系处理记录。」（本轮真库未渲染，仅代码级确认）。
4. 说明：本轮自动化跑的是当前工作树版本，工作树含其他并行任务的未提交改动（`desktop/tests/sqlite-memory-management-view.test.mjs`、`desktop/src/renderer/SqliteMemoryManagementPanel.tsx` 等），非 HEAD 纯净版本。

## 5. 未覆盖与剩余风险

- 真实库上「待确认/处理中·未完成」分栏、候选原因码文案、自动采纳记忆「查看来源」与「撤销」入口均未取得真实 App 实测证据；原因是 §3 的源资格阻断使候选与正文均不可展示（0 候选分栏、5/5 无当前版本）。
- 撤销操作：真实库上按钮不可达，且会写真实库，未执行；仅在自动化合成桥用例验证「按钮可达 + 点击发出 decide」。**按钮可达性（合成）= 通过；真实库执行（会改数据）= 未执行（按约束避免改真实数据）。**
- 真实新拆分码（relation_* 四码）与旧码兜底文案未在真库 UI 出现（真库无新码数据，候选也不展示）。
- 前台定位三条码未构造真实失败场景（需微信前台与故障现场；本任务范围是记忆管理页）。
- 自动化均为合成夹具，不能替代真实数据质量结论；`test:app` 未使用，未启动第二份 Electron 实例。
- 真库数据阻断（277 位围栏 / 目标联系人绑定 revoked）属既有数据状态，是否修复另属其他任务；本页实现本身未获得反证。
- 截图裁剪依赖人工核对；CUA 未采集聊天正文，未展开来源引文，未记录联系人姓名/ID。

## 6. 操作与清理

- 未 `git add`/`git commit`；除本证据文件（`.scratch` 已忽略）外未改仓库文件；未触碰工作树既有未提交改动。
- 未写真实库；记忆自动处理开关保持关闭；未执行任何决定类操作。
- 开发实例仍在运行（supervisor `node scripts/dev.mjs` pid 96759 未变；dev App 在验收结束时为 pid 98844，21:44:36 又因并行任务保存源码热重启为 pid 4036，非本任务操作），供后续复用，未清理；管理后台窗口保持打开、会话内选择了联系人（仅本地会话状态，未产生资料写入）。
