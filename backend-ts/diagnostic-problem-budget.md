# TS 诊断问题累计预算

本入口只为显式绑定的问题诊断提供额外硬上限；现有任务资格、单轮物理上限、调用回执、来源与供应商授权仍须通过。真实资料范围和停止流程见[质量诊断工作流](../docs/agents/quality-diagnosis.md)。

## 接口与启用

`bindDiagnosticProblemBudget(environment = process.env)` 返回 `null` 或 `{reserve(): () => void}`：

- `NOTALONE_PROBLEM_BUDGET` 与 `NOTALONE_PROBLEM_ROUND` 同时缺省时返回 `null`，不读写总账，正常产品沿用原行为。部分配置、相对路径或无效文件直接拒绝。
- 路径必须指向已存在的 SQLite 普通文件，文件及直接父目录须属于当前用户、无组或其他用户权限，分别按 `0600` / `0700` 配置。拒绝文件软链接；运行时不创建总账、轮次或目录。
- 工厂绑定绝对路径、文件身份与轮次。换 cwd、prompt、运行目录和重启执行者均须继续使用同一账本；工厂绑定后撤 env、替换文件或改成公开权限均不能解除原限制。改变轮次需按原工作流结案，再以新轮次重新安装 provider。
- `reserve()` 在 `BEGIN IMMEDIATE` 内检查问题、额度、期限、未结案轮次及无改善次数，将 `used` 加一并提交。返回的函数仅复验停止条件，不再次计数；最后一个有效额度仍能执行自己的复验。预留后任务许可拒绝、取消、进程异常、未知响应都不退款。

两个变量须在安装 `installModelProvider` 前进入实际 DSH 进程的 **OS 环境**。在另一个 shell 中 `export`、只改运行时 `.env` 文件或只改上游请求字段，都不能给已运行的 provider 启用保护。启用方须验证实际子进程环境；不得把配置文件存在当作已生效。

`installModelProvider` 的普通 `prepareExtensions` 与 strict 核验 `send` 在请求尺寸合格后、原 `beforeDispatch` 回调前各执行一次预留，原回调成功后复验，再进入 HTTP。两条路径共用同一 SQLite；E、strict-V、B、关系／合并核验、L2/L3、学习，以及同 provider 的其他 TS 请求都受此限制。这里不按业务 HTTP 入口或 permit 计数，也不在任务账本 `reserve` 重复扣一次。

## 总账兼容与起点

直接读写既有 `notalone.problem_budget.ProblemBudget` 的 `budget` / `rounds`，不新增表或迁移。管理 CLI 已移出当前工作树；按[质量诊断工作流](../docs/agents/quality-diagnosis.md#准备总账管理工具)从固定历史提交隔离恢复。SQLite 写锁用于约束共用账本的 Python 与 TS 进程；TS 产品执行不启动 Python、Conda 或子进程。

默认按工作流在发送前准备 `8` 次、`30` 分钟的账本。SQLite 内只有原有计数与轮次；**新统计起点及此前次数 unknown 须由执行者在同一问题的私有启动记录中明确写下**，并关联固定问题 ID 与绝对路径。`used=0` 只表示本账本创建以来没有预留，不能描述此前历史调用总数。账本准备与管理命令沿用上述工作流，不在产品中增加审批 UI 或任意执行工具。

原有 `continuations` 若含明确的新授权记录，沿用其新增轮数与期限，但不改变 `max_calls` / `used`。本模块只读取记录，不创建授权、延长期限或清零。既定诊断轮次不通过该入口自动延长。

总账接触不到正文、供应商凭据、联系人或模型输入；只读取原问题计数与轮次，唯一持久修改为 `UPDATE budget SET used=used+1`。起点记录也不得放入正文、凭据或联系人姓名。

## 原许可与回执

`HostModelAccounting` 与实际宿主账务实现 继续校验真实任务 claim、请求身份、原任务／job 上限和旧 unknown；本改动不恢复、删除或改写旧回执，也不换任务重放。预算拒绝发生在新任务预约前，不会制造新的 unknown。若任务授权等待跨过截止或轮次被关闭，原回调完成后复验会阻断 HTTP；已知未发的提取调用沿原处理写 `cancelled / not_sent`。

内部 `ModelProviderObservation.before_dispatch_started` 在普通／strict 两条路径初始均为显式 `false`，问题预留成功后、进入原预约回调前同步置 `true`。它只说明回调是否开始，不证明 HTTP 已发或任务预约已成功。L2 caller 仅在 `=== false` 时将原未预约许可安全结算；旧观测缺字段、回调内预约 ACK 丢失及 `true` 都保持原未知处理，不能用 `dispatch === 'not_authorized'` 猜测。该收尾条件由记忆场景模型调用方处理。

该计数是保守预留数，不能冒充实际 HTTP 请求数、token 数或账单。真正 HTTP、usage、失败与 unknown 仍以原 receipt／出站台账及实际传输证据分别核对。截止阻止后续发送，不中断已经在途的请求；在途调用继续受原超时和取消约束。

## 验证与限制

在 `backend-ts/` 使用项目 Node 环境执行：

```sh
node --test --test-concurrency=1 test/diagnostic-model-budget.test.mjs
pnpm run typecheck
```

当前专用用例使用合成账务夹具、私有临时账本和本机 HTTP 假 provider，覆盖两种发送路径、跨进程累计、预算停止与旧 unknown 等场景。Python／TS 并发互操作的旧用例保存在固定历史树，按[历史测试说明](test/HISTORICAL.md)显式运行；历史结果不代表当前版本通过。当前用例、历史用例与真实外部模型验收须分别报告。

此入口只覆盖通过本模块安装的 TS provider。旧 Python 发送仍须走其已绑定总账的边界；它不是全局网络防火墙。启用方负责把同一逻辑问题固定到同一 ID、路径及启动配置；模块无法识别恶意更换 env、手工清零 SQLite 或重新起问题名的语义绕过。已有旧 unknown 的任务仍须先由原写入方核对，预算可用不等于获准重放。

实现使用 [Node v24.19.0 `node:sqlite` 接口](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)及锁定的官方 DeepSeek adapter；新增依赖为零。
