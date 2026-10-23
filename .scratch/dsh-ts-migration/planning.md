# 精简 DSH 与 TS 后端迁移任务索引

> 2026-10-23：用户已认可26项拆分、依赖与验收入口并要求发布，随后明确开始01并开启目标模式及独立会话并行。01与02已通过验收并resolved，03已认领并派发目标会话，其余按真实状态等待；当前执行前沿为03，下游按真实依赖阻塞。依据[规格](spec.md)、[ADR-102](../../architecture/adr/102-dsh-typescript-backend-migration.md)与[已批准拆分](ticket-proposal.md)。

## 逐项任务与阻塞关系

| 任务 | Blocked by | Triage | State |
| --- | --- | --- | --- |
| [01 建立行为与数据基线](issues/01-behavior-data-baseline.md) | 无 | ready-for-agent | resolved |
| [02 验证专用 DSH 后台](issues/02-dsh-runtime-validation.md) | 01 | ready-for-agent | resolved |
| [03 从桌面启动和管理 TS 后台](issues/03-desktop-backend-lifecycle.md) | 02 | ready-for-agent | resolved |
| [04 选择已有联系人并读取上下文](issues/04-contact-context.md) | 03 | ready-for-agent | resolved |
| [05 生成可追溯的基础候选](issues/05-traceable-replies.md) | 04 | ready-for-agent | claimed |
| [06 管理并受控读取现有回复 Skill](issues/06-reply-skill-library.md) | 04 | ready-for-agent | claimed |
| [07 探索方向并使用 Skill 生成候选](issues/07-exploration-skill-replies.md) | 05、06 | ready-for-agent | open |
| [08 继续讨论和改写候选](issues/08-discussion-continuity.md) | 07 | ready-for-agent | open |
| [09 查看和修正记忆及表达偏好](issues/09-memory-and-preferences.md) | 04 | ready-for-agent | claimed |
| [10 从现有消息提取并核验候选](issues/10-memory-extraction-verification.md) | 05、09 | ready-for-agent | open |
| [11 裁决和正式采纳记忆](issues/11-memory-adjudication-adoption.md) | 10 | ready-for-agent | open |
| [12 查看完整来源和处理追踪](issues/12-source-processing-trace.md) | 11 | ready-for-agent | open |
| [13 整理 L2 场景](issues/13-l2-scenario-organization.md) | 11 | ready-for-agent | open |
| [14 更新 L3 画像与关系概览](issues/14-l3-profile-overview.md) | 13 | ready-for-agent | open |
| [15 学习、审核和发布 Skill 草稿](issues/15-skill-learning-review.md) | 06、10、13、14 | ready-for-agent | open |
| [16 导入单联系人历史](issues/16-contact-history-import.md) | 04、10 | ready-for-agent | open |
| [17 接管资料整体删除与管理入口](issues/17-cross-domain-deletion.md) | 08、12、14、15、16 | ready-for-agent | open |
| [18 管理微信账号与同步授权](issues/18-wechat-scope-binding.md) | 03、04 | ready-for-agent | resolved |
| [19 持续同步授权私聊增量](issues/19-private-incremental-sync.md) | 18 | ready-for-agent | open |
| [20 同步既有历史并恢复缺口](issues/20-history-gap-recovery.md) | 19、10 | ready-for-agent | open |
| [21 根据前台会话定位联系人](issues/21-foreground-contact-location.md) | 18 | ready-for-agent | open |
| [22 管理全部业务后台任务](issues/22-background-task-management.md) | 10、13、14、15、20 | ready-for-agent | open |
| [23 保留用量、配置和诊断界面](issues/23-usage-settings-diagnostics.md) | 03、05 | ready-for-agent | open |
| [24 演练完整切换与兼容回退](issues/24-cutover-rollback.md) | 17、20、21、22、23 | ready-for-agent | open |
| [25 完成模型与实际桌面验收](issues/25-integrated-acceptance.md) | 24 | ready-for-agent | open |
| [26 退役 Python 和旧框架](issues/26-retire-python-frameworks.md) | 25 | ready-for-agent | open |

01交付见[基线总览](baseline/README.md)。02实际裁剪运行已验收（`0564283b`、`fc8dcf50`），证据见[运行记录](runtime-validation/progress.md)。03已在`9f39d6c2`验收，04已在`f4acc05d`/`2dd9ad4a`验收；05、06、09、18已派发独立目标会话并行实施。ready-for-agent表示规格足够清楚，不表示前置已完成。实施时逐票使用新上下文，先读规格、当前规则及最新前置结果；认领时改为claimed，通过验收才改为resolved。

## 必须先看 DSH，禁止凭猜测修改

用户新增硬要求已写入全部任务：涉及 DSH 的改动先读锁定版本官方文档、源码和示例，记录版本、依据与适配理由；不要臆造接口、绕过官方机制或擅改核心。资料与源码不一致时以锁定版本核对并用测试验证，不能依靠框架名称或印象做迁移。纯业务票也应核验其交互边界并说明是否涉及直接接口。

## 执行与协调

- 默认按基线／运行方式、完整回复、记忆与Skill、其余后端、验收退役推进；可执行前沿由真实依赖决定，不同时争用桌面或同一业务写入职责。
- 05必须验证TS前台与仍在Python中的后台共享模型许可；10后续接管后台。17是整体删除入口闭合，不把权限／删除推迟到17；24是组合切换演练，不把各票回退推迟到24。
- 15已按批准建议的条件补13／14依赖：学习素材本身不要求L2／L3，但审核预览通过生产回复上下文读取当前场景目录与画像；核对入口见下方记录。
- 新旧每项业务唯一执行和写入方；不能自动双实现兜底，不能回退数据库覆盖用户新增、编辑和删除决定。
- 旧首用／同步／删除缺口保持原任务状态和负责人；01建立承接矩阵，03／18协调现有准备接口，后续不重做已完成能力或复活已退役功能。
- 日常仅npm run dev，先核验复用热更新实例，不打包、不运行打包版；真实资料及消息发送不因发布票据获得额外授权。

## 发布时依赖核验

15的学习输入与targets来自既有素材和Skill；审核comparison通过生产回复上下文读取L2／L3。只读核对位置：

- [审核上下文构建（49行）](../../backend/src/notalone/application/skill_review.py)
- [生产分层上下文装配（186行）](../../backend/src/notalone/server/reply_wiring.py)
- [联系人与本人资料捕获（608行）](../../backend/src/notalone/reply/context.py)
- [当前L2／L3读取（736行）](../../backend/src/notalone/persistence/layered_memory.py)

该证据只用于发布时落实预留依赖，不代表新TS实现或质量验收通过；实现前以最新代码重新核验。

## 本轮验证

检查26份独立任务的编号、Triage／State、规格链接、批准依赖及有向无环关系，核对新增DSH查证要求和Markdown链接。仅文档发布，未认领／执行任务、未处理业务数据、未运行App／模型／迁移或打包。实际检查结果以本轮提交与回报为准。
