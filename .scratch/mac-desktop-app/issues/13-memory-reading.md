# 13：关系资料查看与来源回溯

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 06
Spec: ../spec.md

## 交付行为

查看联系人及本人记忆、待确认候选、采纳方式、时间和来源。

覆盖规格用户故事：39。

## 验收条件

- [ ] 资料按当前范围显示，auto/manual/pending 可区分，不把候选标为已确认事实。
- [ ] 来源聊天时间、保存时间及缺失信息正确展示；可查看现有来源和版本引用。
- [ ] 切换联系人不显示旧范围结果；空资料与加载失败有可见状态。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-09：开始实现只读资料链路。用户已选择“先继续不触桌面的工作，实机验收稍后安排”；本轮仅代码、类型检查和隔离后端 HTTP 验证，不启动 Electron、Playwright App、CUA 或原生对话框。公开 App red → green 继续待认可时段，验收勾选与 resolved 保留待完成。
- 2026-10-09：只读候选实现读取现有四个 GET：当前联系人有效记忆、当前本人有效记忆、当前联系人 pending 候选、当前联系人来源目录。主进程按已验证连接 generation、联系人 `scopeRevision` 和每栏操作 revision 拒绝旧结果，具名桥接复用 App 来源校验并拒绝额外身份/URL/非法参数；认证不传到 renderer。四栏分别显示加载、真实空结果和安全失败，支持独立重读；文本按 React 普通文本显示，不解释 HTML。未新增后端 API、表、算法、编辑/删除或业务 SSE。
- 2026-10-09：如实区分自动采纳（可撤销）、手动采纳和待确认候选，标明 self/contact/shared；本人资料按当前本人共享。保存时间、来源聊天时间和生效/失效时间分开，未知与不完整保持可见；混合 `source_ids` 仅在真实匹配当前联系人来源目录时展示其已有元数据，其他引用不猜类型。版本/候选只展示已有 `supersedes_memory_id`、`source_candidate_id` 等引用，未承诺完整历史正文。任务 14、15、19 继续保持各自范围。
- 2026-10-09：验证基点已从分配时 `a3d200f8f47f4649a91a93208861189f5829f338` 快进到集成 `ef86567f1f9c7d5c780f2f03cac939eef3f05264`（仅任务 04 收尾文档）。Context7 无可调用工具，回退核对 [Electron ipcMain](https://www.electronjs.org/docs/latest/api/ipc-main)、[contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge)、[React useEffect](https://react.dev/reference/react/useEffect) 与 [Playwright Electron](https://playwright.dev/docs/api/class-electron)，锁文件与复用的安装版本同为 Electron 44.7.0 / Playwright 1.64.0 / React 19.3.0。官方文档与类型可用不代表实际 App 已通过。
- 2026-10-09：实际通过 `desktop/` 的 `npm run typecheck`、`npm run build`，以及根目录激活 Conda `NotAlone`、独立 dotenv/握手/CLI/探针/模型环境后的 `PYTHONPATH="$PWD/backend/src" python desktop/tests/fixtures/memory-database.py check-http`。自检核验当前工作树真实后端与本轮随机 `_test` 库上的夹具数据、auto/manual、pending 主体、有效期过滤、完整/不完整/未知时间、来源/版本引用、当前 owner/contact 隔离与空结果；不是对未改后端 API 新增镜像回归。首次自检仅因等价时区的 ISO 表示不同而失败，改按带时区 datetime 语义核对后通过；各轮都回收本轮库和自有服务，最终轮取得真实认证 stopped 响应并正常退出。自动审批曾拒绝外层 `rm -rf` 写法且未执行，改用上下文及 `rmdir` 后成功。未读取私人 `.env`/默认握手、既有业务库、真实微信、剪贴板或真实模型。
- 2026-10-09：`memory-reading.spec.ts` 与 `memory-stale.spec.ts` 的十条公开 App 用例已保存并通过类型检查，覆盖可见资料/时间/引用、空结果、独立失败重读、非法具名参数、同范围更新、A→B→A 和断线重连后的旧成功/失败。未运行用例、未证明 UI red/green；来源详情布局、本人共享范围、失效显示和桥接拒绝均待认可时段实际验收。新增用例全部使用现有受限 `runningApp` fixture，没有新增原始 Electron launch 路径。本轮没有执行 App、安全调度中的 Playwright 或打包实机验收；`git diff --check` 与 `node /tmp/notalone-app-context.p9MPie/validate-tickets.mjs` 通过。任务仍 claimed、全部 UI 验收框未勾，Standards/Spec 两轴由主 Agent 统一安排。
- 2026-10-09：主 Agent 完成完整两轴评审：Spec 为 0，Standards 硬问题为 0，仅保留可能的 P3 重复代码（联系人与资料夹具重复环境准备和嵌套资源收尾）。修复前合入指定集成 `136a5bafc9d69e5208f6c9eaf45cc786469b1fe9`，按冲突技能保留资料页与绑定授权的 main/preload/共享 bridge/管理页两侧接线及文档、门禁与任务 04 记录；固定修复基点为合入后 `5853634975c40b0d6976cadd19acb2bef5a51ebc`。
- 2026-10-09：抽取小型 `tests/synthetic-backend-fixture.ts`，仅复用 `contact-fixture.ts` 和 `memory-fixture.ts` 的 Conda 检查、独立目录/环境、合成库准备、可选自有后端就绪与嵌套收尾。两处保留各自 Python 数据脚本、参数、准备超时和现有后端/公开 App 边界；App 仍只能由已有 `runningApp` 经 `launchApp` 门禁启动，没有新增通用 Harness、生产逻辑、协议、schema 或实际启动路径。资源清理顺序保持自有后端 → 本轮随机库 → 本轮临时目录。
- 2026-10-09：本次实际命令：合并装配后 `npm run typecheck`、`npm run build` 通过，夹具去重后 `npm run typecheck` 再次通过，`git diff --check` 与二十张任务辅助校验通过。仅测试夹具结构变化，未重复未改的后端 HTTP 自检，未建立私有模块镜像测试；helper 的运行时准备/收尾及全部 UI 用例尚待公开接缝实际验收。没有创建数据库/后端/App/桌面租约或其他运行资源，仅临时复用同锁依赖目录，候选提交前移除该链接。增量复核由主 Agent 协调；保持 claimed、所有验收框未勾，不写 Answer、不解除 14/15 依赖。
- 2026-10-09：主 Agent 的原完整评审结论单独保留：候选 `8bb851b10c40c98f871f1f6c2061489252ad06b4` 的 Spec 为 0，Standards 硬问题为 0，仅有可能的 P3 夹具生命周期重复。该结论没有把未运行的 UI 用例计为通过；P3 已由后续小型共享 helper 修复。
- 2026-10-09：主 Agent 已完成固定修复基点 `5853634975c40b0d6976cadd19acb2bef5a51ebc` 至候选 `f6f38d907e350e5bf225bb53cc9da9e92c4434f2` 的增量两轴：Standards 硬问题 0、可能问题 0，原 P3 已消除；Spec 为 0。合并装配保留双方接线，夹具抽取保持原生命周期和隔离语义；完整及增量评审的最终未解决问题为 0，不能据此宣称实际 App 已验收。
- 2026-10-09：类型检查、合并后的资源构建与差异/任务辅助校验已经通过，历史隔离 HTTP 夹具自检证据保留其原范围。新 helper 运行时准备/收尾与十条公开 App 用例均未运行，全部 UI red → green、可见布局、范围失效及失败重试仍待用户认可时段。本次仅追加 Comments 并运行 `git diff --check` 与二十张任务辅助校验，不重复 types/build、PG/HTTP 自检或任何 App/Playwright/CUA/桌面操作。
- 2026-10-09：本树生产候选固定在 `f6f38d9`；集成分支后续已加入任务 07，由主 Agent 合并时适配接线并核对类型，不在本次纯文档收束中混入新源码或沿用旧 UI 结论。任务仍 claimed，验收框未勾，不写 Answer/resolved，不解除任务 14/15 依赖，不改变既有数据或读取授权。
- 2026-10-09（统一集成复核）：在任务 09 的 merge `47f8a911d7b8a6772a48e05ba216056ffa6b0a7e` 后，以 merge `8e0ca8aae604b2adc958ee7e559081807e0063dc` 合入本任务；最终组合 `npm run typecheck && npm run build` 为 exit 0。主 Agent 对这两次合并的最终候选完成双轴复核：Standards hard 0 / possible 0、Spec 0，历史预览、改写、只读资料和会话授权入口完整，共享 helper 仅保留原消费者，07 UUID、HTTP 延迟条件和启动门禁不变。
- 2026-10-09（递延边界）：合成夹具 helper 的运行时准备/收尾、十条公开 App 用例、最新版组合 UI 与签名包仍待用户认可时段；类型、构建和两轴结论不替代实际验收。任务保持 claimed，验收框未勾，不写 Answer/resolved，不解除 14/15 阻塞或改变其他依赖。本次仅补文档记录，不重复测试、构建、后端或桌面操作。
