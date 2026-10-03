# 02：导入后可靠自动处理与状态查询

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01

**What to build:** 用户确认联系人并提交导入后，无需额外 run 即可由后台完成原记忆任务；重复提交、执行条件不足和失败都有可查询的持久状态。

- [x] 通过 BackendServer 公开 HTTP 接缝先观察提交后未自动处理的失败，再使事务成功后唤醒本次原 task_id；消息可用不等待模型，后台失败不回滚或误报导入结果。
- [x] 原任务成功后可检索同范围的派生记忆，并能生成、回看候选依据、同键重放和删除来源；用户无需另发任务启动请求。
- [x] 重复或并发提交相同来源复用原任务并合并唤醒；成功、失败或取消终态不自动重做，失败继续由用户显式恢复。
- [x] 正在运行时的新导入保留唤醒，Worker 全局锁忙后按间隔最多 30 秒的退避继续；后端关闭停止等待，不增加模型失败重试预算。
- [x] 自动处理固定本次原任务，不顺带执行较早旧队列；重启仅保留持久查询与显式恢复，不扫描旧排队任务。默认 CLI 最早领取规则保持。
- [x] 缺模型配置或执行资源时不领取步骤、不回滚消息；原任务保留可明确启动的状态，持久查询提供无正文的最小原因。
- [x] 不同用户和联系人隔离；来源删除、租约失效、等待期间关闭及旧调用返回均不能使已删除资料重新可检索。
- [x] 复用 01 的前台优先和有界关闭，适配模型脚本的异步准备，保留核心闭环、显式恢复与普通润色权限回归。
- [x] 只使用合成资料、自建测试库和 scripted fake；不修改 App、schema、记忆提取／核验／裁决语义或增量同步。
- [x] 相关回归、Python 编译、差异检查完成，按固定基线执行 Standards／Spec 双轴审查，独立本地提交并报告真实证明边界。

## Comments

规格见 [spec](../spec.md)。01 完成调用优先级和生命周期后才能开启自动唤醒，依赖关系由用户确认。

本轮仅在独立工作树的 `codex/import-memory-auto` 分支工作；固定审查基线为 6e67f275cb40cbc1e8f230c153101402f15ff0da。指定任务仅限定调度；提取仍沿用已确认联系人的既有有效消息、水位和窗口，不宣称来源级独立提取。

## Answer

实现、最高接缝验证、完整相关回归和固定基线双轴复审已完成，在本任务独立本地提交中关闭。

1、HTTP 导入成功提交后调用 `TaskHost.wake`，携带已确认的 owner/contact 与原 task_id；任务宿主保留本次进程收到的唤醒。同一任务合并，活跃联系人后续资料排队，全局锁忙或有效租约未结束时持续有界退避，间隔最多 30 秒。终态不自动领取，重启不扫描。显式 `start` 与 CLI 的默认最早任务规则保留。

2、预检查失败在领取步骤前结束，复用 `background_task.last_error_code` 保存 `model_configuration_unavailable` 或 `execution_resources_unavailable`；写入受 owner/contact、queued 状态与有效来源限定，步骤尝试数和模型失败预算不变。后台失败不影响已经成功的消息事务。没有增加 schema、覆盖算法、提示词、模型适配器或 App 行为。

3、新增 `tests.integration.server.test_import_auto_flow` 14 项，通过真实回环 HTTP 与公开 shutdown、正式 PostgreSQL 迁移和生产 Worker 装配验证：自动形成可检索 auto 记忆、候选依据／重放／删除／隔离，重复并发提交，活跃同范围及不同范围的新导入，全局锁释放后的继续处理，缺配置／资源持久原因，三次真实模型失败后显式恢复，较早旧队列不执行，等待中的来源删除与有界关闭，旧调用晚返回不写新记忆。模型脚本与 Event 在提交前准备，来源 UUID 只从实际模型输入取值。既有 HTTP 夹具只在外部模型边界等待响应准备，保留真实存储、步骤和 SSE。

4、已记录有效 RED：初始导入成功且消息可读，但原任务没有自动进入模型；简单启动后，同联系人活跃时新导入的原任务仍 queued；缺配置时持久原因为空。三个纵切分别得到 1、2、3 项 GREEN。安全驱动 `python /tmp/notalone-import-auto-validation.py ticket02-lifecycle tests.integration.server.test_import_auto_flow` 最终 13 项通过，0 失败／错误／跳过。既有夹具独立运行 core 1、rewrite permissions 4、priority lifecycle 14、failed recovery 10 共 29 项通过。`ticket02-api` 的 import API 12、server app 6、import service 8 共 26 项通过。10 个改动 Python 文件编译与 `git diff --check` 通过；产品文件类型诊断无新增，完整统一文件集复核由主 Agent 记录。

复审修正：先通过模型构造 Event 与真实 PostgreSQL 全局锁记录额外 RED，证明显式执行原任务锁忙时，同一 active task 的重复导入唤醒曾丢失。现在合并时先保留去重的可靠唤醒，显式运行结束后仍只继续该原任务；终态复验避免重做。新增最高 HTTP 回归通过；提交后处理收敛为一次任务身份解析、一次资源原因记录。安全驱动 `ticket02-review-regression` 的 auto flow 14、import API 12、server app 6、import service 8 共 40 项全部通过，0 失败／错误／跳过；修正的三个 Python 文件编译与差异检查通过，相关产品类型诊断无新增。

根 Agent 独立验证：`python /tmp/notalone-import-auto-validation.py ticket02-related` 的完整相关回归 730 项通过；审查修正后 `ticket02-review-fixed` 再运行上述四个模块，40 项全部通过，含 14 项自动闭环最高 HTTP 验收。显式排除真实模型冒烟及规格排除的旧库接管维护进程误判模块，不称全仓库全部通过。实现子 Agent 一次联合命令误列 `tests.unit.server.test_app`，产生 1 项加载错误；50 项有效测试通过，正确 `tests.integration.server.test_app` 已独立通过，失败日志保留，不将加载错误计作产品回归通过。

统一类型检查 `python -m mypy --follow-imports=silent --check-untyped-defs --no-incremental` 覆盖本轮两张任务的 10 个产品文件：71 项既有错误／3 文件，相同固定基线旧文件集为 79 项／5 文件。根按文件与诊断内容复核，新增 0、移除 8，未宣称类型全绿。15 个相关 Python 文件编译与 `git diff --check` 通过；自建测试库的两种命名前缀查询残留数量为 0。

双轴审查分别记录：Standards 初审 0 硬违反、1 非阻塞重复代码判断，收敛提交后处理后复审 0；Spec 初审 1 项 P2 同任务唤醒丢失，通过最高 HTTP RED → GREEN 修复后复审 0。两轴未合并排序。

所有运行均先激活 Conda `NotAlone`，`PYTHONPATH` 固定本工作树的 `src` 与根目录。安全驱动自建并删除专用随机 `_test` 库，禁用 dotenv、清空模型凭据／代理／tracing 并拒绝非回环网络；未读取私人聊天、业务库或业务配置，未运行 App、外部模型、安装、部署、push 或 PR。以上证明合成数据上的接线与边界，不证明真实模型质量、微信现场集成或业务库升级可用。数据库本身不可用时无法保证持久原因写入，既有已开始模型调用仍可能晚返回；停机后的恢复依赖原租约与显式入口。
