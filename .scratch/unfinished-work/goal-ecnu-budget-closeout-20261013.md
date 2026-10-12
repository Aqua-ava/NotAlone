# ECNU 估算预算原票收尾核对（2026-10-13）

对应[原票01](../ecnu-reply-budget-adaptation/issues/01-production-estimated-budget.md)及[原规格](../ecnu-reply-budget-adaptation/spec.md)。只补原有限体验终态，不重复已验生产装配、受控模型接缝及原库升级，也不新增真人模型质量要求。

## 原场次的实际证据

- 原第二场预约截止2026-10-12 22:27:30.355（Asia/Taipei），两窗／startup ready于22:07:35.630，公开菜单正常退出于22:27:17.395。实际就绪区间1181.765秒／19分41.765秒；20分钟指预约窗口，不是完整1200秒实开。
- 仓库外私有会话目录 `~/.notalone/experiences/real-ecnu-20261012-jsbsOZ/` 中的 `ready.json`、`finish.json`、`supervisor-finish.json` 均0600。只读取固定状态、时间、已拥有PID及路径元数据，没有读取runner.log、聊天、联系人身份或凭据。
- 就绪收据为真实原库、两窗可见、startup ready、初始未选联系人，Agent自动触发为false，CLI与probe不可用。终态为time_limit、App exit0、认证握手删除、runner exit0、临时spec删除、当场租约absent。
- Root本次核对已记录App与后端PID均不存在、独立userData不存在；`.last-run.json` 的passed仅为补充，完成判断采用上述完整终态收据。首场7.2秒握手解析失败不删除、不改写。
- 私有摘要 `desktop/artifacts/goal-sync-20261013-rf05wl3f/ecnu-prior-experience-terminal.json` 保留三份原收据SHA、时间及清理元数据；当前原库逻辑出站台账的最小只读结果另存 `ecnu-prior-experience-metadata.json`。不提交原资料、配置或原始UI。

## 调用与验收边界

旧场没有持久真实HTTP计数，实际尝试数和用户是否生成均未知；限定时间段逻辑台账0不能代签真实HTTP0。没有真人语义反馈，不声明供应商返回或质量通过。原规格明确排除模型质量评测，其App条件为20分钟有限test:app内开放由用户自主选择／触发；不把缺少额外反馈变成新条件。

本次只核对和更新两份文档：本票新增HTTP0、App0、微信读取／发送0、迁移0。原技术接缝真实验证、本地提交及升级证据仍见原票；当前七项持续目标的记忆模型尝试另计，不挪入本票。核对脚本首轮使用系统Python解析Z时区报ValueError，未写文件或接触模型；改在Conda NotAlone/Python3.12读取同一元数据后通过。最小验证为收据固定字段／权限／摘要及已拥有资源核对、文档相对链接与diff检查；两轴与本地提交在完成后追加。

## 最终核对与本地提交

独立Standards与Spec均0项；评审逐项核原规格、三份固定元数据及未知调用边界，没有读取真实资料或运行资源。Conda NotAlone核5条相对链接、resolved／Answer／六原AC、三收据SHA／0600、时间和清理断言通过，`git diff --check`通过。仅提交本票与本文，不包含其他并行任务、产物或私有资料，不执行远端Git。
