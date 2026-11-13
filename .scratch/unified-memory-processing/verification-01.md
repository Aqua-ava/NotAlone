# 01 验证记录

状态：已完成并resolved。集成分支 codex/unified-memory-processing，工作分支 codex/memory-lifecycle-01，基线 f2545389。

- 用户已授权整个依赖图实现；当前只领取01。
- 实现者记录：正式profile、真实Worker、隔离PG先确认统一状态GET返回404（红）。
- 实现者记录：后端公开HTTP6场通过，覆盖五态与优先级、本人/联系人/owner隔离、旧记录归属、历史46条分页、可靠计数、历史失败与状态失败隔离、查询无执行写入。
- 实现者记录：生产桥接真实MemoryPage连接正式profile与隔离PG通过；相关回归与独立审查待完成。
- 主Agent已通过CUA正常退出监督器丢失的遗留开发实例；dev:status显示stopped。
- 自有合成PG精确记录：/tmp/notalone-memory-lifecycle-pg.json；验收用完后协调精确清理，不接管私人cluster。
- 实际App验收待代码合并后进行，准备脚本 /tmp/notalone-memory-lifecycle-app-fixture.mjs；只用pnpm run dev和合成资料，不配置外部模型。

当前记录不代表实际App已验收、任务已完成或模型质量已验证。

## 最终结果

- 最终tip23b8aa84已快进合入集成分支；生产修复311b96c9。
- 完整后台991项：990通过、1既有跳过、0失败；完整桌面1035项：1034通过、1既有跳过、0失败；双端类型检查与public history=0 issues。
- 两轴独立审查最终0；Spec原2项P2经公开HTTP红绿与独立探针复验消除。
- 实际App通过：未选联系人读取本人；甲/乙切换立即替换状态和历史；同范围失败/成功只显示一主卡；详情中的历史默认收起；合成表可逆改名时状态暂不可用，恢复后重新读取正确。
- 最终代码实际App补验：甲legacy提取失败+有效主题租约仍显示受阻；乙active成功+inactive失败显示完成，失败在历史保留。
- 三次精确自有fixture（含首个进程中断尝试）均已回收，App正常退出，临时注入已还原；测试PG保留供后续票。首次普通nohup子进程未跨执行会话存活，改为nohup+独立进程会话后监督器/宿主实测稳定。
- 不包含模型语义质量、真实微信、02控制或03-06执行生命周期验证。
