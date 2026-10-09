# 08：导入提交、处理进度与重试

Type: task
State: resolved
Triage: ready-for-agent
Blocked by: 07
Spec: ../spec.md

## 交付行为

确认预览后正式导入，更新联系人及来源，查看解析/提取的真实进度和失败恢复。

覆盖规格用户故事：38。

## 验收条件

- [x] 确认后原子提交，重复提交返回原结果；来源、规范消息及首次本人渠道身份遵循现有后端规则。
- [x] 展示真实任务状态、步骤和安全错误；重试原失败任务，不重做成功步骤，不按进度百分比假报完成。
- [x] 导入期间能按现有调度发起前台回复；使用真实 HTTP 与隔离 PostgreSQL 验证成功、回滚及恢复。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Answer

已完成确认后的正式保存、原结果复用、真实五步任务进度及原失败任务恢复。只展示实际保存与后台处理状态，前台回复沿既有调度优先；取消查看或断线不撤回已经发出的提交，未知结果要求重新预览确认。首份本人渠道身份保存后由用户明确认证停读并正常重装配，不自动授予会话读取范围。

源 `60301e84f2f208b4f30458f2d633e335d6ed686a` 的提交4场、迟到7场及首份导入1场全部通过，受限普通页面两个CLI分别exit0、cleanupConfirmed=true；单Chrome，quiet71／10次active/window0、精确测试库和归属进程均回收、两租约absent。原真实HTTP九项与相关后端四十项检查保留。

最新复核发现的准备失败清理P2已修复：建库前保存私有精确归属，只有准备正常退出、需要时后端认证停读且精确库核验不存在才释放；未知状态保留目录、标记和租约。源 `c21b05ef3c7d0672d95bb123d5022c492f18253f` 的真实准备返回损坏JSON和正常bootstrap两项通过，同CLI、exit0、cleanupConfirmed=true，quiet12次active/window0、12条归属身份无存活匹配、两精确库残留0、两租约absent；未知中断分支仅静态核验，未制造未知残留。

初始与修复增量独立Standards／Spec结论最终均hard0/possible0、P0–P3均0；类型、构建、差异及二十票检查通过。只使用合成资料、当前工作树生产模块与随机新 `_test` 库，没有真实模型或微信读取。系统选择器、最新App生命周期和签名包仍待任务20实机验收，普通页面通过不代表完整Mac App交付。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。
- 2026-10-09：依赖 07 已完成，开始接入一次性确认后的原子提交、持久任务进度与原任务重试。用户选择先继续不触桌面的工作，本轮只准备公开 App 用例及隔离 HTTP 证据；必要 App 验收待安排，任务保持 claimed。
- 2026-10-09：真实 HTTP 显示首次 `new_contact_name` 已保存后，同 body 再提交返回 409；联系人、来源、消息仍为 1/1/6。按既定“重复提交返回原结果”获准最小修复：以受控 owner、稳定微信身份与同摘要查找原归属，原 active 来源、active 身份、`manual_create` 确认及当前联系人名称均一致才复用原 contact/task，返回 0 新增、6 重复投影。名称不作匹配键；名称变更、不同文件、原 `manual_select`、错 owner、非 active 来源或 revoked 身份拒绝自动复用/恢复，要求重新预览明确选择既有 UUID。锁定原记录，不新增 schema/DTO/token 或授权，二十张任务与依赖不变。
- 2026-10-09：本轮不触桌面的候选已接入具名提交、真实持久五步骤与安全错误、原失败任务 retry→run、真实联系人/来源刷新和明确认证停读重启入口。取消/断线只废弃本次等待与展示，不能撤销已发出的 commit 或后台任务；结果未知不自动重发，必须重新预览确认。同 body 新建重放真实 HTTP red 为 409，修复后 200、原 contact/task、0 新增/6 重复；首次同 body 并发均 200，仍只有 1 联系人/1 来源/6 消息。HTTP 九项 green 包含名称、不同文件、owner、manual_select、非 active 来源、revoked 身份及并发状态变更零新增副作用，原任务恢复不重做 parse/normalize、前台回复只用当前草稿范围且后台让位。夹具固定身份冲突及非法 deleted 状态的修正不算产品 red。
- 2026-10-09：已合入 root 复核的集成 `8a35aac053ba3985f10fe59bc96abcdabfabe722`，保留 07/09/13/16 与桌面门禁；`npm run typecheck && npm run build` 通过。以当前 `backend/src`、Conda NotAlone、禁默认 dotenv、双向独立配置/握手、模型/CLI/探针的随机新 `_test` 库运行 `desktop/tests/fixtures/import_http_check.py` 九项及 `tests.integration.server.test_first_import_api`、`tests.integration.persistence.test_postgres_repository`、`tests.integration.ingest.test_import_command` 四十项通过；仅该库执行正式迁移，逐次按本轮库名核验残留 0，临时目录/HTTP/任务宿主均按夹具收尾。HTTP owner UPDATE 与 CLI owner KEY SHARE/本人渠道身份 UPDATE 的现有锁区别保留；重放另锁原记录。`git diff --check` 与二十票字段/DAG/链接检查通过，后者不算产品测试。
- 2026-10-09：公开 App 提交、进度、恢复、迟到结果、丢响应及首份身份重装配用例已准备，本轮没有执行 Electron/Playwright/CUA、对话框或剪贴板操作，也未跑签名包、真实微信或语义质量验收；没有 UI red/green 或新截图。任务继续 claimed、验收条件未勾选、没有 Answer，等待 root 统一两轴复核和用户安排 App 时段。
- 2026-10-09（安全维护，待增量复核）：以 `a6ceb873332c44c2bc4e8875b9277adc530af4f9` 为 fixBase，修复实例 `doCleanups()` 的 bool 与类 `tearDown_exceptions` 被忽略而错误 exit 0 的问题。共享清理 helper 先执行实例和类全部清理回调，再核验两类结果与本轮随机库残留；异常或无法确认均非零退出，不能把 stop 命令确认当作清理成功。真实子进程/HTTP/随机 PG 故障检查 red 为关闭、class cleanup、DROP 三种故障均误返 0；修复后两夹具各四种情况共八种 green，正常 0、故障 1，其他 admin/HTTP/临时目录清理继续。被注入阻止的 DROP 如实报告残留 1，由检查器随后只清理本轮库并核验 0；夹具自身不假称已删除。
- 2026-10-09（安全维护命令与边界）：激活 Conda NotAlone、禁默认 dotenv、当前 `backend/src` 和独立读写配置/握手/模型/CLI/探针后运行 `python desktop/tests/fixtures/fixture_cleanup_check.py`；每种情况只迁移随机新 `_test` 库。`node tests/fixtures/fixture-transport-check.mjs` 六项验证真实管道分片、乱序 id、退出拒绝 pending、既有超时、坏记录后仍可控制收尾、受控握手 HTTP；共享 helper 只管传输，08/09 的业务控制、环境及生命周期保留，70 秒 ready、5 秒 command 超时不变。`npm run typecheck && npm run build`、`git diff --check` 和二十票字段/DAG/链接检查通过；未重跑已过四十项业务回归。Context7 不可用，核对实际 Node 25.2.1 的 [ChildProcess](https://nodejs.org/download/release/v25.2.1/docs/api/child_process.html)、[readline](https://nodejs.org/download/release/v25.2.1/docs/api/readline.html) 与 [Python 3.12 unittest](https://docs.python.org/3.12/library/unittest.html)。没有 App/Playwright/Electron/CUA 或桌面操作，没有新 UI/签名包证据；保持 claimed、无 Answer，最终增量两轴结论由 root 另记。
- 2026-10-09（主 Agent 固定范围复核）：完整任务 08 范围 `8a35aac053ba3985f10fe59bc96abcdabfabe722..a6ceb873332c44c2bc4e8875b9277adc530af4f9` 的 Spec 为 0，Standards 原有 1 项硬 P2 与 1 项 possible P3；修复增量 `a6ceb873332c44c2bc4e8875b9277adc530af4f9..b91fdd93d49be4f7513e1d090ce75ab6880ab60a` 最终 Standards 硬 0 / possible 0、Spec P0–P3 全部 0，清理吞错与重复传输两项已解决。代码可安全集成，但评审不替代运行证据：全部最新 App、共享夹具的 App 运行时及签名 UI 仍未 run。本次仅追加文档并做 diff/二十票辅助检查，没有新增测试、打包或桌面操作；任务保持 claimed、无 Answer，验收未勾、后继依赖及 DAG 保留。
- 2026-10-09（App red 后的排序诊断，待增量复核）：固定 base `ddd2e6acdd8ec8b3106473d605f9533f2e3329b2`。root 获用户认可后运行原 08 App 组，10 pass / 1 fail / 1 未 run；仅失败项的最小公开 App 重现仍在原 line 90 收到 `succeeded` 而非预期 `running`，原始日志 `08-app-acceptance.log`、`08-priority-min-red.log` 保留于本轮上下文目录。按 ADR-035 核对：优先的是尚未开始的后台模型调用，已经开始的调用和非模型收尾可以结束；点击完成及尚无候选均不证明回复 HTTP 已到达。原六条资料并非没有后续模型调用：真实 HTTP 探针让回复先等待时，任务保持 running、调用数 1，回复释放后 succeeded、调用数 2；只改变为后台释放后回复 HTTP 才到达，即复现 succeeded / 2。证据定位为验收到达顺序竞争，未发现生产调度缺陷，不改后端、协议或读取授权。
- 2026-10-09（最小修复与 HTTP green）：仅优先级用例准备 46 条合成消息，保留三批提取和首批来源核验；逐次释放实际已开始的外部模型 gate，直到真实回复 provider 进入，再释放全部后台 gate，观察下一次 provider 在 0.3 秒受控回复等待期未进入、原任务仍 running；回复结束后原任务真实 succeeded、调用数继续增长。原任务 ID 从现有公开导入收据读取，避免为观察而重发 commit；不读取私有调度状态，不使用私有 React/IPC 镜像或固定 sleep 证明 HTTP 到达。`python desktop/tests/fixtures/import_priority_check.py` 两项专门 HTTP 检查通过（2.379 秒）：晚到六条基线 succeeded / 2；多批数据前台等待 running / 2 / 下一次未进入，释放后 succeeded / 4。合成模型只证明范围、调用顺序和调度，不证明真实语义质量或微信集成。
- 2026-10-09（验证、收尾及待验收）：上述 Python 命令在 Conda NotAlone、当前 `backend/src`、禁默认 dotenv、独立读写配置/握手/模型/CLI/探针及随机新 `_test` 库中执行；仅本轮库执行正式迁移并核验残留 0。新增三项 stdin 控制还经真实子进程/HTTP/PG 检查：exit 0，实例/类清理均成功、库残留 0、admin 已关闭、两个 HTTP 线程停止、临时目录已删除。`npm run typecheck`、`git diff --check` 与二十票字段/DAG/链接辅助检查通过；未重复已过业务四十项，业务代码未变，无需重打包。只读锁定 Playwright 1.64.0 源码确认 max-failures 的 stop 消息由 `reporter.onError` 记入 fatalErrors，解释日志额外的 `1 error was not a part of any test`，不以此替代资源核验。用户随后反馈宿主前台干扰，root 暂停新的宿主 App；本候选没有启动 App/Electron/Playwright/CUA 或抢租约，没有修改 show/focus，也未用隐藏窗口代替原验收。修改后的公开 App green 与签名/实机 UI 仍待独立环境或后续明确认可方式；任务继续 claimed、无 Answer，验收条件未勾、依赖保留。
- 2026-10-09（共享 HTTP 启动维护，待增量复核）：root 固定范围 `9c12f53b9ec763295460d27edea37a1e09dc9a94..e53899127ddd249c6dd303ce3d2848a91fa5ecb4` 的 Spec 0、Standards 硬 0 / possible P3 一项；以 `e53899127ddd249c6dd303ce3d2848a91fa5ecb4` 为 fixBase，抽取 `import_http_runner.py` 共用临时目录、原完整隔离环境、unittest 运行、本轮精确库名残留查询与非零退出判断。两入口仍自行选择 suite 和目录 prefix，业务断言及生命周期语义不变，保留 root 的三项新接缝文档。激活 Conda NotAlone、禁默认 dotenv、独立配置/握手/模型/CLI/探针后，`python desktop/tests/fixtures/import_priority_check.py` 两项排序检查重新通过（2.371 秒）；旧 `import_http_check.py` 的真实 main 经 `runpy.run_path(..., run_name='__main__')` 执行，仅在 unittest loader 缩小 suite 为原 `test_atomic_first_import_replay_and_final_task_steps` 一项，通过（1.642 秒），不替换业务或 HTTP。已核对 Python 加载本工作树当前 `backend/src`；每轮只迁移随机新 `_test` 库，两个入口正常退出并各自查询本轮库残留 0，临时目录按原上下文收尾。`git diff --check` 与二十票字段/DAG/链接辅助通过。本次为评审阶段去重，不制造新 red，不重复九项/四十项业务组；没有 TS、生产、09 或无头 worker 改动，未重跑 types/build，未执行 App/Electron/CUA/VM/系统输入。修改后的 App green 未运行，原 red 证据保留；08 继续 claimed、无 Answer，验收未勾、依赖保留。
- 2026-10-09（root 固定范围最终复核）：前一范围 `9c12f53b9ec763295460d27edea37a1e09dc9a94..e53899127ddd249c6dd303ce3d2848a91fa5ecb4` 的 Spec 0、Standards 硬 0 / possible P3 一项；共享启动修复增量 `e53899127ddd249c6dd303ce3d2848a91fa5ecb4..bd8b5b41b6009e0f11ecd3fa603f93fcb7c46a6d` 最终 Standards 硬 0 / possible 0、Spec P0–P3 全部 0，该 P3 已消除，代码可合入。复核不替代验收：修改后的页面/App green 尚未运行，原公开 App red 保留，签名与实机条件仍待认可方式。本次只追加本条 Comments 并做 diff/二十票辅助验证，未运行测试、build、App、无头浏览器或 PG。08 保持 claimed、无 Answer，验收条件未勾、后继依赖及二十票 DAG 保持。
- 2026-10-09（普通页面适配静态候选，未运行验收）：合入最新 11 与主集成静态 10/12/14，抽取 `ImportFileSelector` 和独立 Electron 文件选择适配器，生产真实 caller、管理角色、零参数和父窗口绑定继续核验；业务具名桥接和 preload 复用页面传输。真实导入夹具不再导入 App 宿主，十二项原公开场景保留并供普通页面复用；迟到场景保存并等待公开操作 Promise，角色、额外路径和其他 owner 联系人拒绝补入文件变化场景。普通页面宿主只替换本轮 Node 拥有的系统文件选择，复用生产控制器、真实 HTTP/PG；复制与记忆及依据通道保持。首份场景仍从无本人渠道身份的内部 owner 开始，通过明确导入和既有认证停读重启装配 SyncHost，不新增渠道初始化 HTTP；停读或精确本轮库清理未确认保留归属记录和资源标记。`npm --prefix desktop run typecheck`、`npm --prefix desktop run build`、固定范围 `git diff --check` 与二十票字段/DAG/链接辅助检查通过；没有启动后端、PG、浏览器、Electron/App 或系统输入，没有新 red/green 或页面通过证据。共享 CLI 的三个组名登记、十二项当前真实普通页面结果、资源退出与双轴评审仍待主 Agent 协调，历史 App 十项及排序 HTTP 两项不能替代。任务保持 claimed、无 Answer、验收条件未勾选，原生与签名验收仍暂停。

- 2026-10-09（普通页面当前真实验收）：固定源 `60301e84f2f208b4f30458f2d633e335d6ed686a`，激活 Conda NotAlone 后串行运行 `npm run test:pages -- --case import-submit-acceptance --case import-stale-acceptance --timeout-seconds 300`（4+7 项）与 `npm run test:pages -- --case import-bootstrap --timeout-seconds 120`（1 项），当前十二项全部通过，两命令 exit 0；沿用生产导入、文件选择安全校验、控制器及真实隔离 HTTP/PG，系统选择输入仅指向本轮自有合成 JSONL。首份资料保存后通过既有认证停读重启重新装配 SyncHost，保持无已授权绑定，不伪造渠道身份、确认来源或模型成功。两轮各一个无头 Chrome，cleanupConfirmed 均为 true；quiet 采样 71/10、activeSamples 0、maxOnscreenWindows 0，自有 pid+parent+group 身份 64/11 项均无存活匹配，分别收尾后页面/App 两租约 absent。日志、资源、归属身份与清理核验保存在 `/tmp/notalone-app-context.p9MPie/08-final-{submit-stale,bootstrap}-*`，没有旧 App 证据替代或新增失败尝试。最终 `npm run typecheck`、`npm run build`、`git diff --check` 与二十票字段/DAG/链接辅助检查通过；数据只限本轮合成夹具及随机隔离测试库，原生 App、系统对话框、剪贴板、微信、私人资料、外部模型和签名验收未运行。运行权已返还主 Agent；新版适配/夹具的独立两轴复核仍待安排，08 保持 claimed、无 Answer、验收条件未勾选。

- 2026-10-09（Standards P2 静态修复候选，故障回归待运行）：固定初评 `1c8825b317dfb46d93a734b0af101669b321a13a...9da6cd03e372c9fac4d1e440551ff8c965283f09` 为 Spec 0、Standards hard P2 一项：首份准备超时或返回解析失败可能尚未取得库名却误清除资源标记。联系人建库脚本新增仅供本轮调用方使用的可选私有归属记录，先排他写入精确随机库名与准备进程 pid、flush/fsync，再 CREATE；旧调用不传参数时行为不变。首份场景分别记录准备进程正常退出和后端停读，仅两者确认且私有常规归属文件、版本、精确库名匹配后执行指定库 DROP 与不存在核验，然后删除目录和释放标记；JSON 输出解析失败仍可按已持久化归属收尾。超时、失败退出、缺失/损坏/不匹配归属或清理未确认均保留目录、归属文件及 pendingCleanup，不查询或删除任何前缀范围库。类型检查、构建、Python AST 语法和 diff/二十票检查通过；本轮未启动 PG、HTTP、浏览器或 App。最小反馈计划是在独占运行时以真实 create-empty 子进程成功建库后的损坏 stdout 触发调用方解析失败，核对精确库残留 0、目录移除和标记释放，再单独复跑 bootstrap 一项；未知准备超时分支另核其保留语义，收尾未知时停止新启动，保留租约供精确归属恢复。先前正常十二项证据不变，不宣称新增故障 green，任务保持 claimed、无 Answer、验收未勾选。

- 2026-10-09（P2 修复当前真实故障与最小回归）：固定源 `c21b05ef3c7d0672d95bb123d5022c492f18253f`，独占运行时在 Conda NotAlone 通过受限 `npm run test:pages -- --case import-bootstrap-prepare-failure --case import-bootstrap --timeout-seconds 300` 同一 CLI 串行运行两组，各一项全部通过、exit 0、单个无头 Chrome、cleanupConfirmed true。故障 wrapper 调用原联系人 create-empty 完成真实建库/迁移后输出损坏 JSON，准备进程正常退出 0；同一首份生命周期实际捕获 SyntaxError，按本轮私有归属完成指定库 DROP，并以精确 pg_database 查询实际返回 0 证明不存在，删除目录、释放 pendingCleanup。该项没有启动业务后端，backendStopConfirmed 为 null；正常 bootstrap 独立运行真实导入/认证停读重装配，prepareExitCode 0 与 backendStopConfirmed true 分别记录，精确库查询也为 0。两项没有将准备退出等同后端停读。quiet 12、activeSamples 0、maxOnscreenWindows 0，自有 12 项 pid+parent+group 无存活匹配，页面/App 两租约均 absent，运行权已返还主 Agent。日志、资源、身份、清理证明及两项精确库证据保存在 `/tmp/notalone-app-context.p9MPie/08-final-fix-prepare-bootstrap-*`。未知准备超时/失败仅静态核对：prepareStopped 初始 false、只在 await 成功返回后置 true；guard 在 DROP/rm/released 前拒绝，catch 持久化 cleanup-unconfirmed、保留目录与资源标记，不把未知当通过；本轮未实际制造未知资源或重跑 submit/stale 十一项。最终类型、构建、diff 和二十票检查通过；本轮仅合成隔离数据，无 App/原生/私密/模型操作。旧十二项正常及原失败证据保留，新增故障 green 不等于原生验收；新版修复待独立两轴复核，08 保持 claimed、无 Answer、验收未勾选。
