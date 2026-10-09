# 09：草稿改写与候选编辑

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 06
Spec: ../spec.md

## 交付行为

输入或粘贴草稿，选择本次语气/要求，经真实后端生成候选并编辑。

覆盖规格用户故事：22、23、24、25、27、28、29。

## 验收条件

- [ ] 默认 rewrite_draft 且关系语境关闭；用户可明确打开，只提交当前联系人和本次输入。
- [ ] 展示真实候选或澄清、处理中、核实提醒、超时和失败；保留原候选快照，编辑独立存于本次运行。
- [ ] 相同输入重试复用幂等键，改变输入或明确重新生成使用新键；可控模型捕获范围，测试不伪装为语义质量评测。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-09：主 Agent 已完成增量两轴：固定范围 `b72a93468cf5c2c79eb16aafe0798957cb897890..ef44e1794b78d5b397072c6ea50dda8d1014bf66` 的 Standards hard 0 / possible 0、Spec 0，原 P3 已修，merge 五处接线与共享 hook 等价核查无问题。合并及修复后各一次 `npm run typecheck`、`npm run build` 均 exit 0，差异与二十任务辅助检查通过；本次没有 App、后端或签名包运行，不把历史 UI 结果扩张为最新版通过。代码可先由主 Agent 安全合入供整体验收；任务保持 claimed，验收勾选和依赖不变，未写 Answer/resolved，不解除 10/11/12 阻塞，最新源码 App、合并接线与签名包继续待认可时段。
- 2026-10-09：主 Agent 已完成完整两轴，固定范围 `ef86567f1f9c7d5c780f2f03cac939eef3f05264..e025ec42ff93867adcb65bdcf363ecb326e6455a` 为 Spec 0、Standards 硬违规 0，只有订阅/revision 重复的 possible P3。采纳后先合入集成 `136a5bafc9d69e5208f6c9eaf45cc786469b1fe9`；五处真实冲突按 resolving-merge-conflicts 逐处保留 16 授权、09 改写、门禁及 04 记录，固定增量修复基点为 merge `b72a93468cf5c2c79eb16aafe0798957cb897890`。
- 2026-10-09：小型 `useRevisionedSession` 仅供 contacts/replies 两处共享订阅、卸载保护、单调 revision 与切换范围清除错误；各自初始状态、业务操作和具名桥接保留。Context7 不可用，核对 React 19.3 [useEffect](https://react.dev/reference/react/useEffect)、[useRef](https://react.dev/reference/react/useRef)、[useCallback](https://react.dev/reference/react/useCallback) 与实际安装 19.3.0；合并及修复后 types/build 均通过，不添加镜像 hook 测试或通用 store。历史实际验收保持下方记录，最新版 UI、合并接线及签名包继续待认可时段；任务 claimed，未写 Answer/resolved、不解除 10/11/12 阻塞，已完成增量双轴结论见上方记录。
- 2026-10-09：用户明确选择先继续不触桌面的工作，实机验收稍后安排。保留原实现并合入集成 `ef86567f1f9c7d5c780f2f03cac939eef3f05264` 的测试门禁；独立重启显式使用统一 `launchApp`，没有以 `npm start`、直接 Playwright 或旧命令绕过预约。当前只完成源码候选、类型/构建检查与只读启动路径审计；没有新 App 时段或启动额度，任务保持 claimed，等待主 Agent 两轴评审和后续预约验收。
- 2026-10-09：历史实际结果保留：默认改写的关系语境控件缺失、丢失生成响应后的错误分类各经历 red → green；新增 9 条实际 App 行为已分组通过，并在首轮完整回归通过。首轮完整结果为 95 passed / 1 failed，唯一失败是任务 06 尚把生成按钮当占位能力的禁用断言，已改为有草稿时启用。后续完整回归因用户要求优先解决桌面干扰而 Ctrl+C 中止，session 34837 exit 130，21 passed / 75 did not run；不能写成完整 96 条通过。中止后已确认 worker PID 67969 消失，本工作树自有 Electron/后端和改写夹具临时目录已回收。
- 2026-10-09：历史后端相关命令 `python -m unittest tests.integration.server.test_rewrite_history_permissions tests.integration.server.test_reply_api tests.integration.server.test_core_business_flow -v` 在当前工作树 `backend/src`、Conda NotAlone 与隔离配置下通过 15/15；只创建、迁移并回收本轮随机 `_test` 库，未访问业务库、外部模型、微信或剪贴板。合入门禁并适配重启后，`npm run typecheck`、`npm run build` 均 exit 0；文档与辅助校验继续用于候选收尾，不代替 UI 结果。
- 2026-10-09：递延项包括最新源码的受控 App 回归、修正后的任务 06 生成按钮断言、补充的候选单选断言、输入快照文案与要求标签布局、重启门禁的真实 App 适配，以及本任务最终签名包和相关 App 验收。当前模型为受控外部边界，候选结构/权限/幂等结果不证明真实模型中文质量；当前后端没有公开澄清对象，不能把空候选或本地等待冒充澄清或服务端进度。未写 Answer 或 resolved。
- 2026-10-08：任务 09 在独立工作树开始实现；按已批准的实际 App、HTTP 和隔离 PG 接缝逐片 red → green。当前后端仅返回真实候选与风险备注，不把本次 POST 等待伪装为服务端异步进度或澄清结果；评审由主 Agent 统一安排。
- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-09（统一集成复核）：任务 09 以 merge `47f8a911d7b8a6772a48e05ba216056ffa6b0a7e` 合入任务 07 的集成，任务 13 再以 merge `8e0ca8aae604b2adc958ee7e559081807e0063dc` 合入；最终组合 `npm run typecheck && npm run build` 为 exit 0。主 Agent 对这两次合并的最终候选完成双轴复核：Standards hard 0 / possible 0、Spec 0，四项能力保留同一联系人和连接范围、具名入口与管理页面，07 UUID、HTTP 延迟条件和启动门禁均保留。
- 2026-10-09（递延边界）：上述类型、构建与评审不证明最新版 App、共享 hook/helper 运行时或签名包已验收，仍待用户认可的时段。任务保持 claimed，验收框未勾，不写 Answer/resolved，不解除 10/11/12 阻塞或改变其他依赖。本次仅补文档记录，不重复测试、构建、后端或桌面操作。
- 2026-10-09（夹具安全维护，待增量复核）：在任务 08 的 fixBase `a6ceb873332c44c2bc4e8875b9277adc530af4f9` 上同步修复本任务 Python 夹具忽略实例 cleanup bool/类清理异常的相同缺陷，先尝试全部回调再检查并查询自有随机库残留；故障非零，未确认不能报告成功。与 08 共用小型 ready/id/超时/pending 拒绝和受控握手 HTTP 传输，业务 operation、环境、cleanup 与既有 70 秒/5 秒超时保留。`python desktop/tests/fixtures/fixture_cleanup_check.py` 以两份真实子进程/HTTP/随机 `_test` 库覆盖正常、关闭回调、类清理与 DROP 故障共八种；正常 exit 0，故障 exit 1，仍尝试其他清理。DROP 被故障阻止时报告残留 1，检查程序只清本轮库并核验 0，admin/HTTP/临时目录均收尾。`node tests/fixtures/fixture-transport-check.mjs` 六项、types/build、diff 和二十票校验通过；未重跑历史业务或 App 用例，不能更新历史通过记录。没有 Electron/Playwright/CUA、微信、对话框、按键或剪贴板操作；09 继续 claimed、无 Answer，不解除后继阻塞，等待 root 的增量双轴。
- 2026-10-09（主 Agent 固定范围复核）：任务 08 的完整范围 `8a35aac053ba3985f10fe59bc96abcdabfabe722..a6ceb873332c44c2bc4e8875b9277adc530af4f9` 为 Spec 0、Standards 原有 1 项硬 P2 / 1 项 possible P3；覆盖 08/09 共享夹具维护的增量 `a6ceb873332c44c2bc4e8875b9277adc530af4f9..b91fdd93d49be4f7513e1d090ce75ab6880ab60a` 最终 Standards 硬 0 / possible 0、Spec P0–P3 全部 0，两项已解决，代码可安全集成。该结论不更新此前 09 历史验收，也不证明全部最新 App、共享传输在 App 中或签名 UI 已运行；这些仍未 run。本次仅追加文档和 diff/二十票辅助检查，没有测试、打包或桌面操作。09 保持 claimed、无 Answer、验收未勾，10/11/12 等后继依赖和 DAG 保留。

- 2026-10-09（最新普通页面完整验收，待双轴）：按用户已认可的无头接缝，基于集成 `480dcef4b627853c995434f0757d52ed710eec00` 新增受限公开组 `draft-rewrite-acceptance`，九个具名场景各自隔离页面上下文与随机 `_test` 库、同一个无头 Chrome 串行运行。六类公开点击/输入/可见结果与原 App 用例共用，未修改生产业务、协议、schema 或窗口行为。首轮前八场景 green，最后 security 的新公开 evaluate 在页面初始化前执行而失败；先等待真实生成控件可见后，末轮同组 9/9 green、exit 0。此为验收等待修正，不是生产业务 red。实际覆盖默认 `rewrite_draft`/关系语境关闭、明确语境和当前联系人输入、1–3 候选/风险/可见等待/单选编辑及原快照、同键丢包恢复和编辑保留/新输入及重新生成新键、模型超时失败与空候选拒绝、无有效绑定及 owner 隔离、参数/角色/来源限制；两种迟到成功/失败都在真实后端结果到达传输边界后切换联系人或断线重连，释放后等待公开生成 Promise 结束才核验不会回填。正常认证停读后，同 userData 新生产会话不恢复临时草稿/编辑/语气/要求/语境。
- 2026-10-09（本轮资源与递延）：公开命令为 Conda `NotAlone` 下 `npm run test:pages -- --case draft-rewrite-acceptance --timeout-seconds 180`；末轮单 Chrome、48 次只读静默采样，active 0 / 屏上窗口 0 / activationPolicy 2。自有子树 RSS 峰值 KiB 为 Chrome 1048096、Node 214560、Python 191424；共享页可能重复计，构建和 Swift 编译不包含，不代表物理内存或永久上限。每场景真实 HTTP/PG/临时目录与生产控制器收尾通过，`cleanupConfirmed=true`，后续 headless/App 两个公开租约状态均 absent。只处理合成资料、受控模型和本轮随机库；沿用外部追踪关闭链，无供应商、微信、真实剪贴板、按键、对话框、App、VM 或远端 Git 操作。首轮失败与末轮绿日志/资源分别保留；无公开澄清协议，不能伪造。原生隐藏/焦点/剪贴板、最新签名 App 和真实模型中文质量仍未证明；09 保持 claimed、框未勾、无 Answer，不解除 10/11/12，等待 root 双轴。
- 2026-10-09（最小工程核验）：末轮后 `npm run typecheck` exit 0，生产构建由受限 `test:pages` 内的 `scripts/build.mjs` 成功执行；变更 allowlist 的 `node --test tests/headless/command.test.mjs` 为 10/10、exit 0，仅固定 Node 合成孩子，不启动浏览器或 App。后续再核验两类租约均 absent。最后只去掉共享场景未使用的解构参数及无关截图路径，未改变场景操作或断言；类型、差异和二十票字段/DAG/本地链接检查用于提交收尾，不重复已绿业务或原生验收。
- 2026-10-09（完整双轴与唯一 P3 修复，待增量复核）：root 固定 `480dcef4b627853c995434f0757d52ed710eec00..50224679ecf96fcf0c3399ef0127fdec7f149446` 的完整 Spec 为 P0–P3 全部 0，Standards hard 0 / possible P3 一项：新生产会话与原 App 重启重复临时输入准备/清空断言。采纳后只抽取已有 `rewrite-page-scenarios` 内的公开页面准备/断言；原 App 的菜单、`launchApp`、进程退出检查和 headless 的认证停读、新 PageHost 生命周期分别保留，headless 显式开启关系语境、原 App 保持原默认条件。生产代码、协议及二十票范围不变。
- 2026-10-09（P3 最小相关验证）：固定公开组 `npm run test:pages -- --case draft-rewrite-session --timeout-seconds 120` 只调用完整九组中的同一个新会话函数，本次 1/1 green、exit 0；未重跑全部九场景、后端全量或 App。`npm run typecheck`、公开组内真实生产 build、`node --test tests/headless/command.test.mjs` 10/10、全范围差异与二十票字段/DAG/链接检查通过。单 Chrome、13 次静默采样 active 0 / 屏上窗口 0 / policy 2；RSS 峰值 KiB Chrome 1031168、Node 157072、Python 182496（同原采样限制）。真实自有 HTTP/PG/目录/页面收尾与 Chrome 退出确认，`cleanupConfirmed=true`，随后两个租约 absent。本次仅合成资料与随机库，原生能力继续未运行；历史完整 9/9 与本次单场景 1/1 分别保存，09 仍 claimed、无 Answer、验收框未勾和后继依赖不变，等待 root 增量双轴。
