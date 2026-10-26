# Ticket26 宿主退役交接（2026-10-26）
- 分工：仅修改 backend-ts/src 宿主/runtime/legacy 文件和专属 test/python-retirement-host.test.mjs；未操作 index/提交、App/微信、原库、真实模型或配置。
- 接口通知：ContactHandoff/MemoryManagementHandoff 构造器仅收 storage，transfer 已移除，改 activate()；公开 handoff 路由 404，status 保持。
- SkillHost.transfer/privateHttp 已退役，保留 activateStandalone、enter、library、close；删除 PythonTaskControlGateway/TaskControlTarget/LegacyControlError 旧桥。
- ModelHost.pythonEnvironment 改 permit:{path,token}；startHostModelRuntime 不再有 pythonEnvironment，close() 无 stopPython；许可仲裁、socket、journal 与在途结算保留。
- 默认 HOST/reply/extraction/history 均为 TS；显式 legacy/python 选择器在资源初始化前拒绝；旧远程模型环境拒绝，绝不启动旧进程。
- status 固定 runtime=dsh、hostRuntime=typescript，无 legacyPid，ownership 全部仅 typescript/unavailable（schemaUpdates 为 typescript-migration-command），满足桌面 B 复用合同。
- 联系人/记忆继续用原范围事务锁、排空、revision/关闭门禁；ContactHandoff.close 也等待在途 activate，禁止关闭后的迟到激活。
- 唯一保留旧执行器字样的执行相关边界：launch.ts retiredProcessStopped 仅核验并清理已有 legacy.pid 残留，不提供启动/回退；归属不明仍失败关闭。
- DSH 固定 0.2.1-rc.2，源码 687f282e8625c6b8d11ff58211a90524be2e4317；核对已安装 lib/bin.js 与 app-boot/lib/index.js，未升级或改核心/profile。
- 官方源码：https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/bin.ts#L23
- 生命周期：https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/index.ts
- 接口/示例：同 SHA packages/boot/cmdline/README.md:27-33 的 appReady/appExit、packages/bundle/sdk-minimal/cordis.patch.yml:93-129 的显式服务树；本次继续官方 profile + ctx.effect，不引入日志/持久会话插件。
- 已验证：专属回归初始 red；最终 node --test test/python-retirement-host.test.mjs：2/2 pass、0 skip（含默认启动、合成 owner/contact、Skill、采样零 Python 子进程、退役 handoff 拒绝、认证退出）；自有测试库/临时目录已由夹具清理。
- 未运行全量/TSC/额外审查/性能或盲评；root 集成后统一类型检查与实际 dev。
- 测试 C 需更新消费者：model-host/diagnostic-model-budget/extraction-adoption-host 的 permit；host-model-unconfigured/host-model-runtime 的统一默认与 close；contact-context/memory-management-handoff/skill-host/task-api 的退役桥；foreground-location-proxy/host-model-unconfigured-legacy 明确历史边界。
- SQL 116 份未修改；schema Node/PostgreSQL、owner+contact、来源、授权、删除、取消语义保持；仅创建并清理专属随机 _test 库。
- 精确生产变更（backend-ts/src/）：contact-handoff.ts、history-runtime.ts、host-model-runtime.ts、host-plugin.ts、l2-scenario-http.ts、launch.ts、memory-management-handoff.ts、model-host.ts、pure-ts-runtime.ts、skill-host.ts、sync-incremental-api.ts、task-control.ts；删除 legacy-backend.ts。
- 新增测试：backend-ts/test/python-retirement-host.test.mjs；profile/host.patch.yml 无需修改；git diff --check 通过。

## 生成期限阻塞修复（r10/r11）
- r10 创建至失败26340ms、模型4811ms；25秒客户端运输期限可自行断连，B已改候选POST至120秒，本会话未跨写desktop。
- r11 创建至失败37509ms、租约30004ms、唯一物理模型 succeeded/6317ms。源码明确 reply-loop.ts:59 的业务循环计时器创建 ReplyError(reply_timeout)；reply-service.failure 原样保留该错误。租约检查产生 reply_request_expired（Tool层也可能拒绝候选），不产生 reply_timeout。
- 原20秒循环覆盖 SDK whenIdle、Tool校验、requireCurrent、persist，不仅是物理HTTP；原30秒租约从领取开始还覆盖循环前准备。两者均已一次对齐，未移除检查或自动续租/重放。
- 当前前台循环有界90秒，回复服务为该配置领取120秒租约（循环前后留30秒），桌面运输仍由B的120秒上限负责；短测试配置继续有界，通用PostgresReplyStore默认30秒未改。
- 新增 src/reply-execution-budget.ts；修改 src/host-reply-config.ts、src/reply-loop.ts、src/reply-service.ts、src/host-reply.ts；后者仅把后台提取/Skill学习单次期限钳制原20秒，避免前台预算调整扩大后台调用。
- 专属 python-retirement-host.test.mjs 新增一个回归：实际官方宿主+合成模型成功流后业务时钟推进35秒；原代码红（候选被拒），修复后合法保存、模型回执succeeded、实际租约120000ms；第二次显式取消，迟到候选0，物理请求合计2且无重放。
- 验证命令（backend-ts目录）：node --test --test-name-pattern='模型成功后超过旧租约' test/python-retirement-host.test.mjs；1 pass / 0 skip，约2秒；git diff --check通过。未跑全量/TSC/额外审查或真实模型，合成库/进程由夹具清理。
- root/C需同步 host-reply-config.test.mjs:18 的旧 deadline_ms:20000 静态期望为90000（该测试不属本会话文件范围，未编辑）；由root在明确修复后执行一次实际App复验，不自动重放r11。

## 最终精确交接与停止
- 本次期限修复生产文件共5份：新增 backend-ts/src/reply-execution-budget.ts；修改 backend-ts/src/host-reply-config.ts、backend-ts/src/reply-loop.ts、backend-ts/src/reply-service.ts、backend-ts/src/host-reply.ts。
- 本次唯一回归文件：修改（本任务先前新增的）backend-ts/test/python-retirement-host.test.mjs；此前宿主退役13份生产文件的精确清单见上文，profile/host.patch.yml 未改。
- 已跑命令：在backend-ts执行 node --test --test-name-pattern='模型成功后超过旧租约' test/python-retirement-host.test.mjs（原代码红；最终1 pass、0 fail、0 skip、约1.8秒）；在仓库根执行 git diff --check -- backend-ts/src/reply-execution-budget.ts backend-ts/src/host-reply-config.ts backend-ts/src/reply-loop.ts backend-ts/src/reply-service.ts backend-ts/src/host-reply.ts backend-ts/test/python-retirement-host.test.mjs（退出0）。使用委派指定的绝对Node，未依赖Conda。
- 此处停止。未追加模块/TSC/诊断/模型调用、未操作App/微信/原库/预算、未提交或操作index；root统一类型检查并对同原讨论做一次实际生成保存。
