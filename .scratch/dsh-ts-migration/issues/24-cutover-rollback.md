# 24：演练完整切换与兼容回退

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 17, 20, 21, 22, 23
Spec: ../spec.md

## 交付行为

跨业务唯一责任方、在途任务、崩溃重启、结构兼容、用户新增／编辑和删除决定均正确保留。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[17](../issues/17-cross-domain-deletion.md)、[20](../issues/20-history-gap-recovery.md)、[21](../issues/21-foreground-contact-location.md)、[22](../issues/22-background-task-management.md)、[23](../issues/23-usage-settings-diagnostics.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 在独立合成旧库演练整套接管和兼容回退，每功能唯一处理方，在途任务和租约先收尾或安全失效。
- [x] 切换及回退保留新消息、用户编辑、授权撤销和删除决定，不靠旧数据库快照覆盖当前资料。
- [x] 版本不兼容或无法安全回退则停写并报告，不自动降级、换空库或逐请求调用旧实现。
- [x] 崩溃重启、任务恢复、资料删除及前后台调用混合场景无重复副作用、错误归属或敏感副本复活。

## 验证

独立合成库执行明确的新旧接管／回退、崩溃、在途及删除组合场景，不回滚或复制真实业务库。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

## 执行前必须核对 DSH

- 先阅读本票涉及的**锁定版本** DSH 官方文档、相关源码和示例，核对现有 NotAlone 实现；不能凭印象猜 API、配置、依赖或生命周期。尚未锁定版本的01／02先记录候选版本并由02固化。
- 在本票记录版本／commit、具体来源链接或源码位置、核验结论及本次适配理由。官方说明只证明约定，仍需实际测试；不得用可变 master 文档冒充锁定版本证据。
- 优先官方插件、公开接口和已有机制；不胡乱重写框架能力、绕过官方 profile、臆造配置或擅改 DSH 核心。能力缺口须有最小复现或源码依据，影响已确认方案时先报告冲突，不自行换路线。
- 纯业务改动也先判断与 DSH 的交互和生命周期影响；确实无直接依赖时明确记录“不涉及直接接口”及依据，不为完成阅读要求无关重构。

## 工作边界

- 当前仅发布任务，尚未开始实现。执行前核对前置票的实际验收和现有代码，按已确认[规格](../spec.md)及[规划索引](../planning.md)推进，未通过前置不能开始依赖实现。
- 业务始终按 owner_id + contact_id 隔离，来源、权限、预算及删除随本票一起验证；确定性流程由业务代码控制，模型没有外部聊天发送能力。
- 新旧实现每项业务只有一个执行和写入责任方；回退先核验结构和在途任务，保留新增／编辑／删除决定，不恢复旧库或自动逐请求兜底。
- 日常开发先核验并复用 npm run dev 实例，不打包、不运行打包版；本票不授权发送外部消息或扩大真实资料范围。合成验证、真实模型及实际 App／微信证据分开记录。
- 先运行最小相关验证；仅提交本票变更的本地提交，不 push。若范围超过一上下文，先记录完整行为切片与依赖调整，不降低验收要求或任意扩大本票。

## Comments

2026-10-23：用户已认可任务拆分、依赖和验收入口并要求逐张发布；补充明确要求实施前必须看 DSH，不凭猜测乱改。任务保持 open。

## Answer

2026-10-25 完成 Ticket 24 的合成切换与兼容回退验收。

### DSH 查证

- 锁定发行依赖为 `@deepseek-ai/dsh* 0.2.1-rc.2`，见 `backend-ts/package.json:8-17`；官方源码固定为 `687f282e8625c6b8d11ff58211a90524be2e4317`。
- 已对照固定提交的 [Agent 生命周期与 dispose](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/README.md)、[Session 仅默认驻留内存](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/README.md)、[Tool restrict/guard](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/tools/README.md) 与 [LLM 单次 stream/prepareCall](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md)，并核对源码 `packages/core/agent/src/index.ts:152-162`、`packages/core/agent-loop/src/index.ts:550-590`、`packages/core/session/src/index.ts:1047`。
- 本地安装包四份 README 与固定提交逐字节一致：agent `652a3283…`、session `f9f43d36…`、tools `5617d229…`、llm `9cc8f2c8…`。产品仍经 `backend-ts/profile/host.patch.yml` 的官方 profile 和薄 `host-plugin` 启动，不绕过 launcher、不改 DSH 核心。
- 结论：DSH 提供临时 Agent/Session、工具和模型流生命周期，不提供 NotAlone 的业务任务表、原子领取、租约、恢复资格或删除事务。接管与回退均由 PostgreSQL 业务状态和现有 handoff 控制，适配理由是不把临时运行状态冒充权威业务状态。

### 实现与结果

- 新增 `backend-ts/test/cutover-rollback.test.mjs`：在随机 `notalone_t24_cutover_*_test` 库从113原地升级114，保留 owner/contact/来源/消息/记忆身份和原 ID。
- 真实官方 DSH profile 下验证 replies、tasks、imports、memory、contact context、跨域删除和历史同步均为唯一 TS 处理方；在途 contact/memory handoff 先停收排空后只启用一侧。
- 合成导入重放不重复来源、消息或任务；用户偏好修改、撤销绑定与删除来源决定均保留。删除后数据库、业务目录、DSH 临时目录及 Python 兼容读取均找不到删除哨兵。
- 强杀 DSH 主进程后原任务租约仍在；用新宿主连接同一合成库并显式停止任务后，旧 claim 以 `lease_stale` 拒绝，没有重复副作用。
- Python 回复/提取模式回退后，旧业务认证入口可从同一当前库读到新消息和用户修改、保留撤销/删除结果；未知未来账本在发布握手前停写，库和配置不变。
- 修正 `host-http.test.mjs` 对“插入未知版本后账本应含115项”的错误期望。未修改产品运行源码。

### 验证

- `node --test --test-concurrency=1 test/cutover-rollback.test.mjs`：1/1 通过；单例连续重复6次均通过。
- `node --test --test-concurrency=1 test/host-http.test.mjs test/cutover-rollback.test.mjs`：13/13 通过。
- `pnpm run typecheck`：通过，0 错误。
- `pnpm test`：1255/1255 通过，耗时约259秒。首轮全量曾在重负载下出现一次测试宿主 `waitForExit` 清理竞态；随后4路重载组合16/16、两次完整全量均通过，组合测试改为以目标进程真实退出和同库重启为业务判定，宿主清理继续由既有 launcher/host 测试覆盖。

### 数据、清理与未覆盖

- 只创建随机合成 `_test` PostgreSQL 库，未读取、复制、备份、回滚或迁移真实业务库；未调用真实模型、未联网获取资料、未启动 App/微信、未发送外部消息。
- 合成库、连接池、临时迁移目录和当前 DSH home 均按测试 fixture 清理；无残留 Ticket 24 数据库或测试进程。
- 实际 App、真实微信、真实模型质量与性能费用仍由根会话按 Ticket 25 独占验收，本票未认证这些范围。
