# 业务事务错误合同修复

基点为 `e60074b5946b8d1c990fcb75ba13bd58f789b2fb`。本轮只修改指定源码、新专用测试和本目录，未操作 Git index 或创建提交。协调期间 HEAD 推进到 `dbc59a6b78dadbfd10e24d354e46c5ed665da0a4`，其中 host-storage 仍与输入基点相同。

## 根因与反馈回路

`SkillReviewStore.comparison` 抛出 SkillLearningNotFound 后，HostStorage.withClient 原来在回滚后将所有非 HostStorageError 包成 database_unavailable。SkillLearningHttp 因此丢失领域类型，返回 500/internal_error。

- 最小 RED：真实合成 PG 中先插入本人再抛同一 NotFound；写入已回滚，异常身份断言失败。
- 公开审批 RED：同一最终测试仅将 HostStorage import 指向基点原字节源码，实际 500、期望 404。基点源码 SHA-256 为 `0f0395835b6ef630d73cd443311a2dc9eb4b5e18ddc97c2ddaf9e932433ce568`。
- 首版修复只区分 PG DatabaseError 仍不足：实际 query_timeout 会抛普通 Error，定向 RED 揭示该边界；最终按查询抛错对象的来源区分，未匹配 message。
- 基点两个最终 RED、测试 SHA 与 import 适配说明见 baseline-repro.json；各原始日志 SHA 见 commands.json。

## 实现与边界

host-storage.ts:18 的 trackQueryFailures 仅装配到本轮业务事务的独立 pg.Client，记录 Promise 拒绝、回调错误及同步 query 抛错的原对象，保留参数、this、成功返回值及回调形状。错误集合仅在内存存在，不持久化。

withClient:186 只将成功回滚的业务回调异常原样交还上层；属于该连接查询错误或 PG DatabaseError 的异常仍受控。连接、BEGIN/COMMIT、SQL、客户端超时与回滚故障保留数据库边界；原 HostStorageError、关闭屏障、pending 排空、end 收尾及不重放保持。未知回调异常仍由原 HTTP 类型或白名单规则屏蔽。

## 最终验证

| 验证组 | 结果 |
| --- | --- |
| 新 business-transaction-errors 模块 | 12/12，0 skip，约 6.79 秒 |
| host-storage + skill-learning | 28/28，0 skip，约 13.12 秒 |
| reply-http + assistant-discussion-http + l2-scenario-http + source-processing-trace | 11/11，0 skip，约 5.83 秒 |
| TypeScript noEmit | 退出 0 |
| 精确补丁反向 apply --check；diff 空白检查 | 均退出 0 |

最终组共 51 个测试通过，没有运行全量测试。实际 Node 为 v24.19.0。公开命令中的 node24 是工具返回的绝对路径之脱敏代称，非另行安装的命令。实际命令、退出码、历次 RED/GREEN 和原始日志 SHA-256 见 commands.json。

新增覆盖包括 NotFound 同对象及零写入、只读拒写、SQL、同步 query、Promise/回调超时、连接失败、PG 终止连接、延迟约束提交失败、取消原原因、关闭和迟到写入、unknown 原记录及禁止重放，以及公开审批拒绝和未知异常屏蔽。

审批测试使用生产 SkillLearningHttp、SkillReviewStore、SkillLearningStore、SkillLibrary 和 HostStorage；只增加极小 localhost 传输适配，不装配模型。双确认、revision 1、新合成 operation key 和不存在的 comparison UUID 与原触发形状相同。结果为 404/not_found；完整草稿仍 pending/revision 1，冻结目标 v1、启用状态、版本数及正文均相同。伪装 code/status 的未知 TypeError 仅返回 500/internal_error。

unknown 测试把真实 PostgresModelLedger 接到 HostStorage：未知回执仍只有原 attempt，tokens/费用仍为 null；业务拒绝和迟到 pending 不解除禁止重放，不新增授权。

## 只读错误面核验

Skill HTTP 按领域类型响应；Reply、AssistantDiscussion、提取进度和过程追踪使用领域类型及受控回退；L2 使用既有 code 集合/后缀和固定回退，不读取任意 message；host-plugin 仅返回既有受控字段。本轮未修改各 HTTP 映射。Skill HTTP 对真正 HostStorageError(database_unavailable) 仍走既有 500/internal_error，没有越界修改其 503 策略。

## 来源与审查

- 已核对 workflow、engineering、domain、issue-tracker、架构索引、CONTEXT 的 Skill 术语、ADR-102、运行时草案当前入口、相关核心流程/隐私条款及迁移 spec/Ticket25；应用 diagnosing-bugs、TDD。
- 不涉及直接 DSH 接口：HostStorage 无 DSH 依赖，host-reply.ts:224–234 原装配继续把业务事务传给 Skill stores。没有模型、profile 或框架生命周期变更。
- pg 锁定 8.16.3；本地官方包 lib/client.js:520–616 核对 Promise/回调/同步错误与客户端超时，lib/index.js 核对 DatabaseError 导出。未修改第三方包。
- 按 code-review 的 Standards/Spec 两轴自行审查，均无待修发现。遵从本轮“不委派”，未声称独立双 Agent 审查；规范来源为 AGENTS、工程工作流和领域/规格约束，未发现额外 CODING_STANDARDS 或 CONTRIBUTING 入口。

## 数据处理、清理与交接

仅随机合成 PG、合成 Skill 临时文件和 localhost；不读项目 .env、真实资料或真实账本，不调用供应商，不操作 App/微信，不打包、push、PR 或 commit。三个既有 desktop 测试未编辑。无 schema、资料迁移或持久化范围变更。

专用测试 teardown 全通过：自有客户端、pool、localhost server、随机数据库及合成目录均已关闭/删除。仓库外原始日志保留在 0700 目录、0600 文件；复现 node_modules 链接和临时测试 harness 已删除，只保留基点源码与原始回执。公开证据无本机路径、凭据或可识别业务资料，并保留原始 SHA。

root 负责本地提交、提交后公开历史检查，以及按需让原真实 profile driver 固定新提交复验；本轮无实际 App、微信或真实模型验收，不据此签收 Ticket25。
