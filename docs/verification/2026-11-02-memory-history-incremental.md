# 历史与增量记忆处理验证

对应 [ADR-152](../../architecture/adr/152-history-and-incremental-memory-processing.md)。

## 实现范围

- 当前已授权联系人历史导入终页提交后，自动以最多50条文字建立固定历史批；启用边界前的旧增量归历史补齐，新增增量独立排队。
- 增量沿用静默10分钟、50条、最旧6小时和启动间隔30分钟；历史批不推进增量冷却，每个历史批之前重新检查增量，各联系人轮转。
- 候选待决定和主题／概览阶段不单独阻挡新的文字提取；主动暂停、真正L1失败和未知调用继续保留。
- 已知失败最多自动恢复一次；系统中断使用明确原因，可沿原输入安全续跑。恢复前及写事务重新核对来源、控制修订和回执；结果未知不重发。
- 增量建轮、领取、处理前复验和结果提交支持同一来源一次元数据续证；已返回模型结果继续使用原结果，不重调模型。
- 共享微信读取器正常停车后重开通道，完整查证成功才交接原持久守卫；真正身份／来源变化和当前通道停止仍使来源失效。
- 联系人处理卡分别显示历史、增量排队数量，最近一批提取进度不表示累计全部完成。

## 自动验证

使用正常SQLite动作、提取服务、调度器和桌面桥；消息、账号、渠道及模型响应均为隔离合成资料。模型替身证明调度和回执行为，不证明真实模型语义质量。

- `backend-ts/`：`node node_modules/typescript/bin/tsc --noEmit`。
- `backend-ts/`：`node --test test/sqlite-memory-history-auto.test.mjs test/sqlite-memory-backlog-recovery.test.mjs test/sqlite-memory-backlog-isolation.test.mjs test/sqlite-memory-dual-scheduler.test.mjs test/sqlite-memory-l1-scheduler.test.mjs test/sqlite-memory-scheduler-isolation.test.mjs test/sqlite-memory-extraction.test.mjs test/sqlite-memory-control.test.mjs test/sqlite-memory-documents-schedule.test.mjs test/sqlite-wechat-history-channel.test.mjs`。
- `desktop/`：`node node_modules/typescript/bin/tsc --noEmit`；`node --test tests/fixed-memory-processing.test.mjs tests/fixed-memory-processing-view.test.mjs tests/memory-page-fixed-processing.test.mjs`。
- 原`sqlite-memory-hybrid-upgrade.test.mjs`的`storage_invalid`在本轮开始前HEAD的临时工作树同样复现；单列既有失败。新增边界回归证明旧增量归历史、新增量独立，不将该合成边界替身冒充旧升级用例通过。
- DSH固定安装版本`0.2.1-rc.2`，Cordis`4.0.5`；仅增加业务服务的调度接线，未改变官方扩展API或依赖。源码导航仍按固定参考提交核验，未声称安装包与整个源码树逐字一致。

- 后台相关回归115/115通过，桌面桥与页面回归27/27通过；两端类型检查通过。

## 桌面与真实资料边界

- 仅使用`pnpm run dev`，核对开发宿主及监督器；没有打包或运行发布包。
- Computer Use检查实际App的历史／增量处理卡、来源和连接状态，并通过应用菜单及恢复入口停读。
- 旧开发后台退出确认曾卡住；正常菜单、重试停读后，核验精确父子关系，对自有读取进程及遗留后台发送正常终止信号。未删除数据库、来源或未知调用记录。
- 旧实例正常终止后，通过应用恢复入口确认退出，开发监督器串行重启成功。实际页面验证两类队列分别展示；原问题联系人的新增文字已进入独立提取轮，历史补处理轮已自动建立。
- 本轮实际模型仍出现返回格式校验失败，保留对应任务并有限恢复；原有暂停与未知调用保持原状态，积压尚未全部清空。本轮不以调用次数或成功收尾推断记忆语义质量。

## 数据与磁盘

不新增消息副本，不迁移或删除用户数据；新增队列从来源和原处理项派生，恢复次数沿持久任务保留。私人原文、身份和截屏不写入本记录或测试。
构建前主卷与临时卷可用约96GiB，复用现有开发构建目录；未创建发布包，测试临时库及临时工作树按各夹具清理。
