# 固定候选 Spec 独立审查

结论：**approve（本次固定变更的 Spec 轴）**。未发现可复现、由本次变更新增的 P1／P2；没有需要实现方修改的 finding。此结论不签收整体产品切换，也不批准 25／26。

基点为 `e17d4c752c69618e90e43c42488f1cb2c4d1b7a4`，候选为 `ff45f2ec296c4cead326d2ab6f3cf7770c9396ab`。按两对象的单次提交差异审查。测试使用仓库外私有 `git archive` 快照，673 个源码／测试／配置／原 SQL 文件在运行前后 SHA256 一致；20 项安装依赖版本与候选锁定版本一致。共享 checkout 结束时已为 `4f89bb976dd4086a02b7ae983fee2760d6e4ff64`，其后续代码没有进入本结论。逐文件来源见 [fixed-source.json](fixed-source.json)。

依据为 `spec.md:16–18,59–77,85–102`、`acceptance-scope-update.md:18–46`、`issues/25-integrated-acceptance.md:17–28`、`issues/26-retire-python-frameworks.md:15–26` 及既有 Python HTTP／事件和桌面消费合同。仅开展 Spec 轴，没有读取另一轴结论、委派或编辑生产代码。

选定验证分六组，分别为 1／1／1／5／2／1 个通过用例，失败为零；没有把已有组件套件的数量累加为本审查证据。

| 实际入口与范围 | 独立结果 |
| --- | --- |
| 正式 launcher → 公开助手 prepare／异步 status／generate | 同一联系人手动与桌面绑定并存、并发时不串范围；错误来历不能领取准备句柄；prepare 零模型；候选和锚点由真实公开输入创建，持久重放不重复调用。 |
| 公开 interrupt → retry-interrupted → continue | 取消后迟到结果被拒绝且无候选保存；原输入显式重试及继续到完成态。 |
| 公开 inputs／会话分片／候选版本 | 两个 UTF-8 分片均不超过 256 KiB，拼接 SHA256 与 read_id 一致；变化返回 409；through 固定旧编辑版本边界。 |
| 公开 layered-memory → 正式 worker／provider | 21 条冻结目标首批覆盖 20，再显式继续同一任务至 21；新增第 22 条由 dirty 通知建立新目标，暂停工作不被后台自动继续。 |
| 公开 quality-input／quality-runs | 用途确认和 fixed_synthetic 限制生效；缺安装时累计预算 guard 返回 503 且不认领；来源改版按原 SQL 撤销 case/run，旧 run 返回 404；均零物理请求。 |
| 选定真实 caller／Unix 许可／PG | 错 source_ref、错 scope/token、过期和撤销拒绝；中文／emoji／转义实体按 Unicode 字符计数，相等通过、超一拒绝；ACK 丢失保留未知并阻止换 phase 重放；累计八次后第九次被阻止。 |
| 选定管理维护／公开六阶段 | 旧未知任务不能通过继续／刷新绕过；有效期边界撤下旧 L2/L3。正式纯 TS 产品六阶段为 8 次假 HTTP，累计合成 SQLite 账本一致；关闭重开不重放、不发布产品记忆。 |

关键接线已核对候选 `backend-ts/src/pure-ts-public-api.ts:48`、`pure-ts-reply-scope.ts:10`、`assistant-generation-lifecycle.ts:50`、`pure-ts-public-pages.ts:15`、`layered-memory-management.ts:83`、`layered-memory-management-target.ts:17`、`quality-model-authorization.ts:34` 和 `quality-model-caller.ts:75`。它们与公开探针共同构成证据，不以私有 handler 调用代替业务终态。

可重复命令及逐组结果见 [commands.md](commands.md)、[verification.json](verification.json) 和同目录 `.tap`。自编探针的早期草稿修正过输入 DTO、假 SSE、主题版本及终态观察方式；这些探针问题未算成产品缺陷。来源改版的 404 已与原 SQL 级联撤销核对。

数据影响：只使用合成身份、本机 fake provider、随机 `_test` PG 与合成 SQLite；没有读取真实配置、资料、数据库、问题账本或模型，没有 App／微信操作、截图或外部发送。fixture 收尾成功意味着自建宿主、随机测试库和合成目录均执行了专属清理；另在删除快照前核对自有进程引用。清理结果见 `verification.json`。没有暂存、提交、push、PR 或打包，也没有写入用户的三个测试文件。

剩余限制：本次为选定跨模块合同审查，没有重跑全后端／全桌面，也没有认证全部功能矩阵、所有原生或同步状态投影。真实模型语义质量、1152 正式分母／120 资格、实际 App／微信及最终性能仍待验收；既有真实只读诊断的语义失败仍阻止质量签收，不归因为本提交新增缺陷。费用仅暂豁免，预算／取消／来源等约束继续有效。25 未通过，26 不可退役旧实现。

最终交付文件逐项 SHA256 见 [artifact-manifest.json](artifact-manifest.json)。
