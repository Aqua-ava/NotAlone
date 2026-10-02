# 修复重复初始化、复用退出与嵌套签名

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: none

按 [spec](../spec.md) 消除同连接重复初始化，正常退出时关闭同一已认证本地运行时，修正嵌套签名并纠正 AppData 默认授权期限说明。

## 验收

- 同连接不会每三秒启动额外 sessions 初始化；断线仍能恢复。
- 复用后端正常退出有界停读，不改已确认绑定或持久化总开关。
- 关闭仅限认证回环服务，未认证请求不能触发。
- App 与 helper 保持各自标识、稳定签名及完整运行时依赖。
- 合成测试、真实构建、两轴评审与本地提交完成；系统许可未点击则真实读取验证待验，不冒充成功。

## Comments

2026-10-02：用户明确要求处理截图中 AppData 持续授权框；电脑操作工具拒绝控制 UserNotificationCenter，已告知当前系统“允许”须本人点击。代码与本地验证继续推进，无新增权限。

## Answer

同一已验证连接的初始化改为幂等；真实传输失联后轮询仍重新接入并恢复 SSE。初始化状态与本次运行时的已验证关闭连接分开，退出或向导重启不因失联丢失关闭凭据，也不按握手文件后续变化去关闭另一实例。

主 App 正常退出使用主线程 `terminateLater` 等待已认证回环关闭请求。运行时先阻止新增和排队读取，再取消当前 I/O 并正常关闭；只在 stop 成功后报告 `stopped`，失败保留 `stopping`，重复关闭幂等。旧同步宿主不得重新启动；未认证或非回环请求拒绝，客户端超时有界。请求失败只收尾 supervisor 自己启动的 Process，复用实例保留关闭未获确认的提示。现有 SIGTERM 路径和单实例约束保留。

签名改为由内到外分别执行，App、核心库、CLI、运行时库各有 identifier，保留现有依赖与权限说明；纠正默认 AppData 授权只在 App 打开期间有效的说明。

验证记录：

- `swift test -q --filter BackendAttachmentTests`：先缺接缝失败，再通过；后补失联保留关闭连接回归同样先失败再通过。
- `python -m unittest tests.unit.server.test_runtime_shutdown -q`：认证关闭、真实 HTTP 收尾、幂等与状态先失败再修复；当前 4 项通过，另含关闭失败不冒充成功、可重试。
- `python -m unittest tests.integration.server.test_server_command.ServerCommandProcessTest.test_authenticated_runtime_shutdown_exits_and_removes_info -q`：先 503 失败，装配后通过；成功后正常退出并清理合成握手文件。
- `python -m unittest tests.unit.server.test_sync_host -q`：停后读取先失败，修复后 21 项通过；公开并发检查覆盖正在执行的周期、已排队 check、幂等 close、旧宿主禁止重启和持久开关保持。
- 相关 Python 6 个模块共 68 项通过；此后新增关闭失败回归的 runtime 模块 4 项通过。主 App `swift test -q` 共 33 项通过，Swift 6 同时编译真正 App 目标。`zsh -n macos_app/scripts/build_app.sh`、`git diff --check` 通过。
- Standards 初评 2 项、复审 0 剩余；Spec 初评 3 项、复审 0 剩余。原发现涉及失联关闭连接、排队读取与 SSE 恢复，均已修复；Spec 复审独立执行 6 项合成关闭／并发检查通过。
- 根 Agent 对最终源码运行隔离全量 Python：36 次迁移、1141 项测试通过，跳过 3 项；本次新建 `_test` 库已删除并查询确认不存在。自动化未使用业务库或外部模型凭据。
- 源模块 `mypy` 未通过：当前 65 项错误；用 `--shadow-file` 对固定基线 `cab0bcc` 的三份源文件重新核验，同为 65 项，新增 0、消失 0。保留真实失败及对照日志，不将既有类型欠账说成检查通过，也不把无关大范围类型整改混入本任务。
- 最终 `zsh macos_app/scripts/build_app.sh` 重建成功，App 递归严格签名、CLI 探针严格签名均通过。主 App、核心库、CLI、WCDB 库 identifier 分别保持独立，helper 与动态库均打包完整；构建仅使用私有临时副本与单次子进程环境，未改全局 PATH。
- 用户明确回复“已点允许”后，真实 App 状态恢复 CLI 后台同步；20.17 秒、95 次进程采样观察到一条 App→后端链，0 个重复 sessions 进程，已验证运行时为 running。短采样只说明该窗口行为，不能证明长时或跨重启永久无弹窗。
- 通过 App 的正常退出操作实机验证，App、后端及原读取进程全部结束，握手文件移除；随后打开最终新版，恢复原联系人与“你好”草稿。最新同步为 active、全局流在线、CLI failure 为空；另有历史补齐 `cli_message_table_missing`，仍为 incomplete，未冒充全部历史完整。

数据影响：仅合成本机服务和 `_test` 库用于自动化；实现不修改业务记忆、联系人绑定或持久同步偏好，不触发外部模型调用或聊天发送。实机验证沿已有授权的已绑定范围运行；系统“允许”由人类处理。工程修复、最终打包及实机退出完成，按主题本地提交，不 push；长期持续运行和 OS 默认跨运行授权期限仍须分别对待，不能宣称永久免弹窗。
