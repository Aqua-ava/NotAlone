# 03 — 隔离、更新、删除与故障验证

> Triage: ready-for-agent
> State: resolved
> Blocked by: 02
> 规格：[Hindsight 本机记忆召回对照实验](../spec.md)

## 交付行为

在实际服务与实验适配器中修正、失效或删除合成资料，证明旧结果无法进入上下文，并单独核查外部索引副本的清除；失败和竞态可重复演示。

## 验收

- [x] 跨 owner、跨 contact、错误 bank、相同正文不同 ID、缺失映射和陈旧 revision 均不会产生越界依据；同时含能正常选入的有效正例。
- [x] 回读后及上下文选入后注入删除/修正竞争，最终 validate_current 拒绝旧快照；时间边界独立分组，不污染静态收益组。
- [x] retain/更新/删除/重建重试幂等；单来源、多来源、整条记忆与联系人 bank 的生命周期符合本地资料支持规则。
- [x] 对 document、chunk、memory unit、向量、运行缓存与重启后检索核验外部删除；无法证明的备份/介质残留列为限制，不能只凭本地拒绝宣布外部清除。
- [x] 服务不可用、超时、部分重排未完成和返回异常均显式记失败；不隐式用 A 冒充 B 成功。
- [x] 双预算、本人本地路径、普通改写未授权参考资料和复验直通保持原有边界。
- [x] 完成已确认接缝的 red → green、相关回归、类型检查及真实服务生命周期验证；清理仅触及本实验资源。

## 完成记录

分别记录本地拒绝与外部副本清除证据，填写实际命令、结果和限制，再改 State。

## Answer

- 真实服务复跑通过 27 个检查点，证据和中文报告分别位于 `experiments/hindsight/lifecycle-result.json`、`experiments/hindsight/lifecycle.md`。API/SQL/向量单元/archive、同实例缓存、重启检索和 bank 作用域索引分别验证，控制范围仍可召回。
- 新增同步 lifecycle runner 和固定独立库的只读 SQL 核查；客户端精确 allowlist，并明确区分删除后 404 与服务错误。停止 runtime 时核对 PID 归属、等待 API 退出再停 pg0。
- red → green 覆盖精确 bank allowlist、多来源支持更新与幂等删除，以及空响应必须有本次完成日志。13 个新增测试与现有实验/Context 回归共 51 项通过；5 个相关源码模块 mypy 通过，`git diff --check` 通过。完整命令在报告中。
- 数据仅为新建公开合成夹具，业务默认路径、生产库、模型配置和向量开关未改。来源/revision 更新使用声明的合成权威快照；实际 correct 生成新 UUID，旧 ID 失效。外部故障和竞态使用边界替身，未冒充真实收益。
- 活动 SQL 和可检索副本清除不证明 MVCC、WAL、备份或介质物理擦除。全部本轮 bank 按 allowlist 清理，API 与独立 pg0 保留供任务 04；最终 Standards/Spec 两轴审查由主 Agent 对集成变更统一执行。

## Comments
