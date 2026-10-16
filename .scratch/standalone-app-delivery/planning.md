# 独立本机 App 实现索引

用户于 2026-10-16 确认五项粒度及依赖，并要求持续实现。

规格：[首次使用与兼容更新](spec.md)。架构：[ADR-061](../../architecture/adr/061-standalone-local-app-onboarding-and-updates.md)。

| 任务 | 依赖 | 状态 |
| --- | --- | --- |
| [独立安装包完成本机首次设置](issues/01-managed-first-run.md) | 无 | open |
| [受控授权完成微信首次接入](issues/02-wechat-onboarding.md) | 01 | open |
| [确认联系人后同步并生成候选](issues/03-confirmed-sync-and-reply.md) | 02 | open |
| [备份并完成兼容更新](issues/04-preserving-data-update.md) | 01 | open |
| [完整两路验收与交付检查](issues/05-release-acceptance.md) | 03、04 | open |

仅完成 Answer、验证与独立审查后将对应任务标记 resolved；研究、编译、合成回归、真实 App 与真正无开发环境结果分别记录。
