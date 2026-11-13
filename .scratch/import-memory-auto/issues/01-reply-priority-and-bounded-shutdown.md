# 01：后台调用让回复优先，并可有界关闭

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: None

**What to build:** 用户已有后台记忆任务运行时，新的候选回复能在当前后台调用结束后优先执行；关闭后端能够停止后续工作，并保留真实的未完成状态。

- [x] 在 BackendServer 公开 HTTP 接缝复现并修复后台下一次模型调用抢在已等待回复之前的问题；候选请求的等待发生在生成器启动任务、取得请求租约和 runtime 计时之前。
- [x] 提取、来源核验和写入裁决都复用相同进程内控制；原适配器、提示词、解析、采纳门和台账保持。一次调用包含其内部 SDK 重试，不假设可中断一次正在执行的第三方调用。
- [x] 整次前台回复期间暂停后续后台模型调用；成功、失败和拒绝路径释放许可，后续合法工作可以继续。
- [x] 通过公开 shutdown 生命周期及运行时 HTTP 入口验证拒绝新工作、唤醒等待者停止，并在模型调用或步骤边界停止后续工作；等待上限 5 秒，不将未完成任务误报为业务完成。
- [x] 来源删除或租约失效时保留既有防护，等待中的旧工作不得在来源不可用后继续产生可检索资料。
- [x] TaskHost 的锁连接、线程登记及控制许可在成功、失败和停止路径中正确收尾；CLI 默认行为、全局 Worker 锁和每轮三次模型失败预算保持。
- [x] 仅在用户确认的最高公开接缝增加合成行为测试；真实 Worker、PostgreSQL 及存储参与，仅模型脚本化。显式禁用业务配置与真实模型冒烟，并阻止外部网络。
- [x] 相关回归、Python 编译、差异检查完成，按固定基线执行 Standards／Spec 双轴审查，独立本地提交。

## Comments

规格见 [spec](../spec.md)。用户已确认范围、调度与测试边界，以及本任务先于 02 的依赖关系。当前阶段仍由用户通过既有手动 HTTP 入口启动任务，不提前实现导入自动触发。

本轮仅在独立工作树的 `codex/import-memory-auto` 分支工作；固定审查基线为 6e67f275cb40cbc1e8f230c153101402f15ff0da。独立 CLI 的模型优先级不由本任务扩展。实现保持记忆提取器的既有联系人范围、水位与窗口语义。

## Answer

第一张已完成公开接缝验收、固定基线双轴审查与相关回归，在本任务独立本地提交中关闭。

- `application/model_priority.py` 提供框架无关共享许可，分别包裹提取、来源核验、裁决和整次 ReplyPort。等待在生成器启动之前；E/V/A 适配器、提示词和算法未改。
- `TaskHost.stop` 拒绝新任务、唤醒等待者并最多等待 4 秒，为 HTTP 关闭留出余量；生产同步与任务收尾共享同一等待预算。锁连接在 `finally` 关闭，不能中断的旧调用返回后停止后续模型与步骤，不将后台线程结束投影为业务成功。
- 必要局部持久接线仅新增原来源／租约复验及协作停止记账：保持步骤 `running` 和原租约，在 claim 仍有效时只返还本次 `attempt_count`，租约到期后从原步骤显式恢复；真实错误仍记失败，停止不掩盖其预算。没有 schema 变更，CLI 默认领取不变。
- 原流程被停止／租约检查打断时，`MemoryCallAccounting` 与真实提取 runner 的薄包装为已返回的提取／裁决调用补充无正文台账；许可控制器只管理停止、等待与 guard。普通水位持久失败不补记，正常成功、真实失败和核验原台账不重复计数。来源删除期间的等待在下一次模型调用前复验，不产生新可检索资料。

RED 证据：第一条真实 HTTP 回复在阻塞的提取未结束时已经进入模型；关闭返回后等待回复仍未结束；停止后实际提取调用的台账计数为 0。三个缺口分别记录首失败并修复，没有用内部控制器单元测试代替公开行为。

审查修正也先取得公开 HTTP RED：专用合成库的临时 PostgreSQL 触发器拒绝一次水位写入，真实 runner 的 4 次模型调用被重复记为 5 条。将补记限定为实际控制／guard 中断后，公开汇总为 4 次全部成功，晚 E/A 丢弃记录仍保留；触发器在测试结束清理，业务 schema 未改。

验证使用 Conda `NotAlone` 与 `/tmp/notalone-import-auto-validation.py`，驱动固定本工作树 `PYTHONPATH`、随机 `_test` 数据库和 `/tmp` Unix socket、禁用 dotenv、移除模型凭据／代理／tracing并阻止外部网络：

- `python /tmp/notalone-import-auto-validation.py priority-review-final tests.integration.server.test_model_priority_lifecycle tests.integration.server.test_core_business_flow tests.integration.server.test_failed_task_recovery tests.unit.application.test_reply_service`：新最高 HTTP 模块 14 项通过，耗时 106.460 秒。覆盖 E/V/A 前台插入、整次回复许可、失败／拒绝释放、31.5 秒等待跨过正式 runtime 和请求租约、来源删除、HTTP／公开关闭小于 5 秒、全局锁释放、晚结果丢弃与无正文台账、协作停止后原租约恢复并保留三次失败、停止后的真实模型错误仍计数，以及普通水位持久失败不重复记账。
- 同一最终驱动的核心闭环 1 项、失败恢复 10 项、回复服务 8 项均通过，共 33 项。另一次 `priority-related` 驱动验证任务命令、运行时关闭、核心闭环、失败恢复及服务器命令，共 28 项通过。
- 新模块单文件 `python -m mypy --follow-imports=silent --check-untyped-defs --no-incremental src/notalone/application/model_priority.py` 通过。9 个改动产品文件联合类型检查仍有 77 项既有错误／3 文件；固定基线为 79 项／5 文件，不能宣称全仓库类型通过。`ReplyPort` 的纯类型签名与生成器既有 keyword-only 调用对齐，差分由根 Agent 复核。
- 11 个改动 Python 文件 `python -m compileall -q` 与 `git diff --check` 通过。

根 Agent 的 `python /tmp/notalone-import-auto-validation.py ticket01-related` 完整相关回归 716 项通过；显式排除用户禁止的真实模型冒烟及规格排除的旧库接管维护进程误判模块。审查修正后，根重新验证水位失败、晚 E／A 台账三条，以及回复服务 8 项、核心闭环 1 项、失败恢复 10 项，均通过。首次晚 A 测试选择名称误拼产生一项加载错误，正确名称单独运行通过；保留失败日志，不计作产品回归通过。根按文件与诊断内容复核联合类型检查：相对固定基线新增 0、移除 2。

双轴审查分别处理：Standards 初审 0 硬违反、2 非阻塞判断，已分离记账生命周期并复用测试，复审 0；Spec 初审 1 项 P2 重复台账，已通过上述真实水位写入失败纵切修复，复审 0。两轴未合并排序。

本轮只处理合成资料和专用测试库；不读业务配置、真实聊天或业务数据库，不运行 App、不调用外部模型、不安装依赖或推送。实现子 Agent 未创建提交，本地提交由根 Agent 在审查后处理。原始输入和资料隔离范围未扩大，最终消息仍由用户亲自发送。不可中断调用、原来源／租约失效、强制结束或停止记账失败时不能保证返还本次尝试；未完成业务仍由数据库与既有恢复协议决定。本任务没有实现第二张导入自动唤醒或增量同步任务。
