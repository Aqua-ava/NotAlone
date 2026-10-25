# 组织质量迁移执行清单与 API

1. 核对 Python HTTP、Store、审核、报告与六阶段执行合同，保留正式 120 资格和本次 1152 协议。
2. 只新增 `backend-ts/src/organization-quality-*`、同前缀测试；共享文件由各负责人接线。
3. 在已授权公开 HTTP seam 写 RED：质量输入创建→重读→Agent 标注→持久 run→无 runtime 503→删除。
4. 实现原表 Store、来源/版本/范围世代/反馈守卫、事实纠错用途和级联删除。
5. 移植严格审核、完整分母、unknown/失败/模型身份和标定规则。
6. 真实执行复用现有 L2/L3 工作区及核验，不发布到产品层；每次物理请求走正式宿主许可与累计预算。
7. 验证本机假 provider 的实际模型 caller、终态、重开、并发租约、删除晚结果与预算耗尽。
8. 运行最小用例→质量相关模块→类型检查；不跑全后端/桌面/真实模型。
9. 扫描新增文件，冻结精确路径与 SHA，交根统一集成、提交和独立验收。

## 窄 API（与管理、宿主负责人协作）

- `new OrganizationQualityStore({transaction,contract,budget?,now?})`。
- `insertInputInTransaction(client,scope,versions)`：管理端已持有范围锁并检查 `settings_generation`；本方法读取实际合法来源及既有主题，保存冻结输入。
- `readInput(ownerId,id)`、`reviewInput(ownerId,id,body,{output?})`、`withdraw(ownerId,id,{run?})`。
- `createOrganizationQualityApi({ownerId,transaction,store?,contract?,runtime?})` → `matches(method,url)`、`handle(method,url,body,signal)` → `{status,body}|undefined`。
- `createOrganizationQualityRuntime({call,binding,profile,diagnosticProblemBudgetBound,sourceRef:qualityInputSourceRef})`；SDK 缺安装时总账绑定或来源匹配时返回 503。
- runtime 使用独立质量 case 租约，不能伪造生产 `background_task_step`；宿主负责注入同一正式模型 caller。
- 未装配 runtime 返回 `503 quality_evaluation_unavailable`，客户端不能授予 `verified`。

## 已核验边界

- `create_run` 只允许 `_test` 数据库、`fixed_synthetic`、1–240 输入和 1–750 次请求。
- 审核绑定实际输入/输出摘要，Agent 审阅永远不是人工资格。
- 既有 schema 079 保留来源、纠错、范围和用途删除触发器；不新增 schema。
- DSH 锁定 `0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`；普通业务模块不创建框架宿主。
- 官方依据：[启动与共享插件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md#L34)。模型运行经现有 profile/许可，不创建独立 provider。
- 桌面、真实配置/资料/账本/模型、Git index/提交由根独占；日常 App 仅 `npm run dev`，本任务不启动 App。
