# 独立本机 App 实现索引

用户于 2026-10-16 确认五项粒度及依赖，并要求持续实现；随后明确接受先交付[手动输入首版](manual-first-release.md)，新增任务06并调整首版验收依赖。原微信任务保留后续范围。

规格：[首次使用与兼容更新](spec.md)。架构：[ADR-061](../../architecture/adr/061-standalone-local-app-onboarding-and-updates.md)。

| 任务 | 依赖 | 状态 | 收尾或后续条件 |
| --- | --- | --- | --- |
| [独立安装包完成本机首次设置](issues/01-managed-first-run.md) | 无 | open | 本机实现已完成，等待无开发环境目标Mac验收（needs-info） |
| [受控授权完成微信首次接入](issues/02-wechat-onboarding.md) | 01 | open | 首版延期，待新的安全可行接入方案（needs-info） |
| [确认联系人后同步并生成候选](issues/03-confirmed-sync-and-reply.md) | 02 | open | 随微信首次接入延期（needs-info） |
| [备份并完成兼容更新](issues/04-preserving-data-update.md) | 01 | resolved | 已关闭，Answer及验收已归档 |
| [手动输入首版两路验收与交付检查](issues/05-release-acceptance.md) | 06、04 | open | 待真实模型、目标Mac、正式签名公证及余下同版组合验收（needs-info） |
| [不依赖微信的手动输入首用闭环](issues/06-manual-input-first-release.md) | 01 | resolved | 已关闭，Answer及验收已归档 |

仅完成 Answer、验证与独立审查后将对应任务标记 resolved；研究、编译、合成回归、真实 App 与真正无开发环境结果分别记录。

2026-10-17收尾核对：04、06的任务单此前已为resolved，但本索引仍误写claimed，现同步。01、05的实现和内部试用证据已经归档，剩余验收未完成；没有活跃执行时退回open／needs-info，不把等待条件显示为进行中，也不将未通过的条件标成完成。

任务01已提供受管Python、PostgreSQL、公开设置与故障恢复；v3普通包及离线修改工具实际交付，来源／通知、签名库存、60迁移及真实备份恢复通过，主Agent完成首启、重复打开和正常退出。真正无开发环境目标Mac仍待验，详见[组合验收](release-validation.md)。

任务04、06已分别完成资料保留更新和手动输入首用闭环，结果见任务单的Answer、[更新验收](data-update-validation.md)和[手动输入验收](manual-input-validation.md)。合成模型与真实模型、开发机与干净Mac的证据边界继续保留；任务05不因内部试用完成而提前关闭。

任务02、03按用户确认延期，不处于当前执行队列。此前特权初始化被工具安全审查中止，不继续或重复该路线，也不把普通CLI合成协议当作真实微信接入成功；历史分项见[组件验证](wechat-component-validation.md)。
