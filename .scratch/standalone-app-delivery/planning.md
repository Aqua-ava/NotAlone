# 独立本机 App 实现索引

用户于 2026-10-16 确认五项粒度及依赖，并要求持续实现；随后明确接受先交付[手动输入首版](manual-first-release.md)，新增任务06并调整首版验收依赖。原微信任务保留后续范围。

规格：[首次使用与兼容更新](spec.md)。架构：[ADR-061](../../architecture/adr/061-standalone-local-app-onboarding-and-updates.md)。

| 任务 | 依赖 | 状态 |
| --- | --- | --- |
| [独立安装包完成本机首次设置](issues/01-managed-first-run.md) | 无 | claimed |
| [受控授权完成微信首次接入](issues/02-wechat-onboarding.md) | 01 | open，首版递延 |
| [确认联系人后同步并生成候选](issues/03-confirmed-sync-and-reply.md) | 02 | open，首版递延 |
| [备份并完成兼容更新](issues/04-preserving-data-update.md) | 01 | claimed |
| [手动输入首版两路验收与交付检查](issues/05-release-acceptance.md) | 06、04 | open |
| [不依赖微信的手动输入首用闭环](issues/06-manual-input-first-release.md) | 01 | claimed |

仅完成 Answer、验证与独立审查后将对应任务标记 resolved；研究、编译、合成回归、真实 App 与真正无开发环境结果分别记录。

任务01已接入受管 Python、PostgreSQL 与公开首次设置。官方源码PG与审查修复的同包组合，在开发机完成Computer Use首启、本人及合成密钥、崩溃停服、搬动重开和正常退出，另完成取消继续与组件缺损恢复，见[首启验证](first-run-validation.md)。两轴复核新增0。真正无开发环境与完整发行核验仍待完成，未将任务关闭。

任务02、04已在可运行首启底座上进入独立实现；依赖关系和最终验收门槛保留。任务02的固定组件源码重建及普通CLI合成协议已取得分项证据，见[组件验证](wechat-component-validation.md)；特权初始化子任务被工具安全审查中止，已停止该路线，原生worker尚未完成。普通CLI元数据裁剪继续；尚未接入真实微信或取得系统权限，不关票。任务04已取得公开入口red，合成旧库的备份、恢复核验、更新与外置迁入后端切片通过；公开App的外置旧库单击更新已有开发包green，完整故障路径、同包CUA及标准构建继续实现。
