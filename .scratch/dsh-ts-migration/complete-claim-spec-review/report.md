# 完整命题核心差异：独立 Spec 审查

结论：**approve**。没有发现足以要求修改的 Spec 缺陷。结论仅绑定下面的固定核心差异；后续输出配置增量尚未收到 pin，不能把当前工作树纳入批准。

- 基点：`d4e7690bd9f57a2fae66b04d348219476c0cb497`。
- 核心候选：`bcc6701ce67249d18b51625c07f4cad4e401ad04`。
- 差异 34 路径；31 个 payload 文件 + 原 manifest + 根集成两份证据。
- 原 manifest：`.scratch/tencent-source-reuse/quality-followup/complete-claim/manifest.json`。
- 原 manifest SHA-256：`88b7c4844d766f1ded51fd877ec1dab6e6d374d6983212558a9bac9e2281990f`。31 项摘要逐一一致。
- source stamp：`2e36ada0f02a44d6cf709a0cd1255f5ffeb7f5a56491e2549b0de9ce274b1b64`。

## 规格与源码判断

按 `acceptance-scope-update.md:40–49` 的最新用户决定，不将 4096 输出容量、费用比或费用预算作为本轮门槛；旧测量保留历史属性。其余依据为迁移 `spec.md:59–75,79–102`、票 25/26、`architecture/current/core-flows.md:19–45` 和 ADR-104:9–17。没有读取另一审查轴的报告或私有真实材料。

| 要求 | 固定候选中的对应行为 |
| --- | --- |
| 仅显式新任务使用新策略 | `extraction-task-store.ts:44–70,73–80` 在新建任务固定 v2；冲突不改旧快照。schedule 的旧 observation 复用分支不升级配置。默认宿主仍 legacy，无新增产品 API。 |
| A 的窗口、缓存与 unknown | `extraction-task-runner.ts:90–130,209–215` 固定窗口策略；`extraction-batch-service.ts:107–140,192–240` 先查 unknown，缓存身份包含策略、输入与规则，返回缓存前复验来源与取消。 |
| 全文与适用条件共同准入 | `complete-claim-verification.ts:78–100,150–184` 连续覆盖全文并合取 facets；`extraction-protocol.ts:184–187` 保留事件和条件检查。receipt 只接受本次准备器绑定的结果。 |
| 真实 B 围栏和五字段 claim | `extraction-adoption-service.ts:228–260` 在模型前后及每个写事务前后读取真实任务/窗口策略；`extraction-task-store.ts:48–61,345–360` 在真实租约内复验。claim 没有新增策略字段。 |
| 116 与旧数据路径 | SQL 116 只扩展约束，不改 NULL/v1；宿主计数为 116。035 基线、103 Skill 迁移和 114→116 定向用例通过。 |

## 独立反证验证

在仓库外 0700 的固定 SHA archive 中执行，使用锁定依赖链接；没有复制 `.env` 或真实资料。实际 Node 为 `v24.19.0`。

1. 真实 `enqueueImport → claim → Runner → A → B`：E/V 各一次；第三人称、shared 与忠实未知日期共 3 条 auto 记忆通过，未核验事件/条件、缺 facet、uncertain 共 4 条零写入。来源 receipt、trace、7 条处理回执和最终水位一致；缓存零额外调用，取消保留原错误。
2. 在 B 的 `memory_candidate` INSERT 后、同一真实事务内篡改任务策略：事务因 window mismatch 回滚，候选、记忆、水位和处理回执均为 0；配置也回滚。恢复后原 A 才能正常完成 B，HTTP claim 仍为 5 键。
3. 合成物理调用已记为 `http_accepted/unknown` 后令旧任务 stamp 失配：原任务失败并隔离该消息。换来源新建当前 v2 任务时目标仍为空，没有第二次调用或记忆写入。
4. NULL、v1 legacy、v1 bounded 三类旧任务冲突重入均保留原值；6 次非法 v2 写入被 SQL 拒绝，116 宿主只读兼容为 ready。

4 个业务探针全通过；TAP 包含父测试为 5/5。另只复跑固定 archive 的 035、102→103→116、114→116 三个相关迁移用例，3/3 通过。命令见 `verification.json`，合成源码见 `probe.mjs` 和 `schema-regression.mjs`，结果见 `final.log`、`schema.log`。

初次探针的两处夹具错误为账本枚举误写 `failed`、将 SQL NULL 写成 JSON null；原失败、诊断和定点修正日志分别保留，没有修改产品代码或把 RED 覆盖为 GREEN。

## 边界与交接

本审查没有运行真实模型、实际 App、微信或真实库迁移；没有给质量、Ticket 25/26 或整体产品批准。模型是否能可靠判断真实完整命题仍待根会话独立验证。输出增量需新 pin 后仅追加小差异审查，再绑定最终候选。

34 路径源码前后 SHA 一致。所有合成库均普通 DROP，自有目录按 fixture 精确清理，最后 archive 清理证据见 `cleanup.json`。原始 raw/private 文件现完整归档仓库外 0700 目录、文件 0600；仓库同名文件只是脱敏副本，原始/公开摘要与外部归档索引摘要见 `log-binding.json`。先前把私有原件留在仓库内的错误及修正见 `privacy-repair.json`，RED 与结论身份保持。没有操作共享 index、commit、push、PR、App 或用户已有桌面测试。

资源协调核对：`notalone_ts_host_02322a79e4524a58af847ae625cae297_test` 与 `notalone_ts_host_8ca9c0a8b0ea4dd994a8b1998efdd7f3_test` 均不在本审查全部 9 个自有合成库的精确清单中；没有持有、删除或推测其归属。
