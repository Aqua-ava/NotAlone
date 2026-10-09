# 修复跨工作树真实桌面验收的并发与焦点干扰

Type: task
Triage: ready-for-agent
State: claimed

## 问题与既有红证据

用户明确反馈多个 Agent 反复启动、退出 NotAlone 并抢走桌面焦点，电脑无法正常使用。07 与 09 工作树同时执行完整 App 组；每个 Playwright 命令虽设置 `workers: 1`，但没有跨命令、工作树或 Agent 的互斥。`npm test` 默认构建并运行完整真实 App；`runningApp` 每条用例启动并关闭一次，另有独立重启和重复实例路径。生产窗口正常 `show`/`focus` 会放大测试启动频率的干扰。

07 收尾时自然完成 101/101，09 Ctrl+C 以 130 中止；主 Agent 已确认两者自有 Electron、后端和本轮临时资源回收。这些是原问题的运行证据，不是本修复的验收结果。用户要求先修复调度再继续原二十任务，本任务独立存在，不增加原任务图。

## 本次修复采用的测试命令与调度边界

- 普通 `npm test` 只执行类型检查和不触桌面的安全命令回归，并明确输出实际范围及 App 未运行。
- 真实 App 仅由主 Agent 在用户认可的有限时段通过显式 `test:app` 执行。命令必须给出交互声明、协调人、开始/截止时间、最小文件范围和启动次数预算；最终全量仅在预约时段显式选择一次。
- 跨工作树、Agent、TMPDIR 和 userData 使用同一 OS 用户的稳定私有租约。租约不确定、损坏或崩溃后不自动抢占，也不依据未知 PID 终止任何进程。
- Playwright 直接调用和每个 Electron 启动/重启/重复实例都必须核验活租约；时段到期后不再新启动。Ctrl+C、超时和故障只能收尾本 runner 拥有的孩子；收尾不确定时保留租约、拒绝下一轮。
- 保留正常 App 窗口的 show/focus，保留原 [spec](../../mac-desktop-app/spec.md) 公开真实 App/HTTP 接缝和最终签名包/实机验收。没有独立桌面 runner 时诚实安排预约，不以 DOM、未知 headless、app.hide 或 showInactive 宣称静默 UI 通过。

## Testing Decisions

本问题新增的公共 Seam 是测试 CLI：未协调调用拒绝、活租约互斥、过期拒绝、启动预算、信号/崩溃后安全收尾及不确定锁拒绝。这是主 Agent 为落实用户明确的调度修复目标选定的必要验证，不表示用户逐项确认了 CLI 设计或新的预约时段。合成 Node 孩子只替代系统进程边界，不操作 Electron、原生对话框或桌面。此安全反馈不证明 App 业务、窗口或 HTTP 闭环。

`diagnosing-bugs` 的真实故障重放与最终原场景复验因用户明确暂停指令跳过；现有用户反馈和并发运行证据足以定位调度缺陷。先通过公共 CLI 的安全红绿、类型检查和只读启动路径审计，候选保持 claimed，由主 Agent 安排 Standards/Spec 两轴评审并询问必要的最小预约验收。

## 范围与排除

只改测试调度、命令、fixture 和对应中文文档。不修改生产窗口、领域行为、原二十功能任务、签名或权限；不启动 App/CUA/系统按键，不读取私人 env、默认握手、业务库、剪贴板或微信，不 push 或创建 PR。只保存不含业务数据的租约元信息，token 仅在本轮进程内传递。

## Comments

- 2026-10-08：用户通过主 Agent 明确优先修复本问题，独立发布后立即认领。固定基点为 `3b12ad319f56eabbff1ab841f4fb107c337d5013`，分支 `codex/mac-app-desktop-test-scheduling`。主 Agent 统一评审，候选阶段保持 claimed。
- 2026-10-09（Asia/Taipei）：安全 CLI 反馈按垂直切片形成：未协调入口缺失 red → 明确拒绝 green；跨副本租约缺失 red → 不同 cwd/TMPDIR 的命令副本互斥 green；原始 Electron API 门禁模块缺失 red → 独立 Playwright worker 在 spawn 前拒绝 green。预算/到期切片首次仍等待五秒且返回 0（预期 124），接入合成孩子与租约后发现异步等待覆盖中断状态，修复后按期返回 124、第二次启动领取拒绝并正常收尾。全量发现首次因空范围环境值 JSON 解析失败，修正后可安全列出、限定文件且排除安全目录。
- 2026-10-09：最终 `desktop/npm test` 通过 TypeScript 与 13/13 安全 CLI：跨两份独立命令副本及 TMPDIR、次数、到期、SIGINT 130/SIGTERM 143、runner SIGKILL 崩溃后的孩子退出与陈旧锁拒绝、到期疑似复用 PID、损坏/FIFO 记录、原始 launch 与主配置拒绝、全量/限定文件发现。`npm run test:app -- --interactive` 实际拒绝为 2/`app_test_unapproved`；`npm run test:app:status` 为 0/`absent`。`git diff --check` 与主 Agent 的二十任务字段/DAG/链接辅助检查通过。后续守卫将 Playwright 启动等待上限也限制到剩余时段，并对 socket 建立失败及无效协议原文使用安全错误；这些收尾改动只补相关类型与单项门禁验证，不重复全套。
- 2026-10-09：启动审计确认本基点 fixture、桌面设置重启、联系人重启以及重复实例均经过统一门禁；07 `57c10b9` 没有新增独立 launch，09 未提交的 `rewrite-restart.spec.ts` 另有原始 launch，合入主配置门禁可覆盖同一 API，但恢复前仍须合入并改用显式受限 `launchApp`、审计新增路径。旧树未合入时不会受租约自动拦截。本轮没有执行 Electron、App 打包、native dialog、CUA/系统按键、Python/PG/模型/微信或读取私人资料；仅测试租约元信息、固定合成 Node 孩子和各自临时副本。真实窗口正向启动、到期/强制回收以及签名包/实机项仍需主 Agent 安排最小预约验收；安全绿灯不替代原 App/HTTP 证据。候选保持 claimed，等待双轴评审。
- 2026-10-09（Asia/Taipei）：候选 `078257dc74a9a3bcceceb3a733bb86997ded8d8b` 两轴评审后，只处理三项增量。Standards 的路径要求通过迁入本文件及修正原 spec 相对链接落实；仓库中没有其他旧路径引用。采纳重复逻辑维护建议，抽取私有 `monitorLease` 共用心跳、重入保护、到期、升级 timer 与退出清理；App 保留正常 close 后 3/5 秒信号升级，普通 ChildProcess 保留直接 SIGTERM 后 3 秒 SIGKILL，信号始终只作用于仍存活的自有孩子，不增加通用 Harness。
- 2026-10-09：Spec 的缺记录问题经公共 CLI red → green：本轮合成锁目录已创建但没有 `lease.json` 时，原状态命令返回 0/`absent`，新增回归失败；修复后为 2/`app_test_lease_unsafe`，后续领取仍为 `app_test_locked`。仅锁目录本身不存在才能报告 absent，记录缺失、读取失败或归属不明均保留锁。单项 green 与类型检查通过；相关状态/预算/中断/崩溃/原始 API 和主配置门禁共 10/10 安全检查通过，差异及二十任务辅助检查通过。未重复完整安全组，未运行真实 App、CUA、打包或业务数据库；共享监视器的真实 Electron 正向适配仍待预约。保持 claimed，交回主 Agent 增量两轴复核，不写 Answer/resolved。
- 2026-10-09（Asia/Taipei）：主 Agent 完成修复候选 `7308830f7c4dcf7d40e513ff911f118b71bcc1bd` 的增量双轴复核。Standards 新增 hard rule 0、possible smell 0，原任务路径与监视逻辑重复问题解决；Spec 0，原缺记录 P2 已解决，并确认共享监视器保留到期与自有 ChildProcess 收尾边界。此结论只覆盖本轮修复候选，不把安全 CLI 验证当作真实 App 通过。用户已明确选择“先继续不触桌面的工作，实机验收稍后安排”，受控正向 App 验证递延；已完成代码、安全 CLI 验证与双轴评审的修复可先由 merger 安全合入。原任务可恢复代码、后端安全验证与只读评审，所有真实 App、CUA 与键盘操作仍暂停；没有新的时间窗口或启动额度，此前两次 CGEvent 限额已用完。本轮仅记录评审与用户决定，执行差异/链接核验及文档本地提交，不启动 App、项目、测试、CUA、打包或原功能任务，继续保持 claimed，不写 Answer/resolved。
- 2026-10-09（用户新反馈与实际目标）：用户曾明确允许继续验收，主 Agent 在统一门禁内取得单次窗口/正常退出 1/1、导入组 10 passed / 1 failed / 1 did not run，以及同一失败的单项复现；各命令均已退出、租约 absent。用户随后反馈前台仍“一跳一跳”影响正常使用。串行、时限与预算只限制干扰规模，没有实现“不打断日常桌面”，本任务仍 claimed。已停止新增宿主前台验收；用户明确拒绝虚拟机并同意后台接口＋单实例无头浏览器方向，由关联任务 02 实施。原生验收仍待有限时段，不能用后台成功关闭这些条件；原两次 CGEvent 授权已消费，不追加按键。
