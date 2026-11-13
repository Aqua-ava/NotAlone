# 目录 Skill 数据库精简

Triage: ready-for-agent
State: resolved

用户明确要求沿用目录 Skill 方案，清理数据库里不必要的 Skill 表和字段，只保留必要业务状态。

## 实现决定

- 目录仍是内容唯一来源；不可变版本的无正文 manifest.json 保存描述、质量警告和资源索引，数据库只保存其完整性哈希。
- 移除 reply_skill_resource 整表；移除 reply_skill.description/directory_managed、reply_skill_version.name/description/content/validation_warnings、reply_skill_method.title/instruction。
- 保留稳定名称与身份、联系人范围、版本定位/完整性、当前与启停状态、审核/方法延续/政策、来源删除依赖、使用回执及可重试文件清理。
- 旧资料先完成目录及清单落盘并验证正文/全部资源/方法，再在同一迁移事务中删除旧结构；失败保留原结构与资料，可重试。
- 加载目录只读无正文清单；正文、资源及允许的方法仍按需读取；清单损坏拒绝使用，不回退旧数据库。

## 验证决定

沿用用户已确认的 Skill 管理接口、SkillPort.catalog/load_version/load_resource，以及逐版本迁移命令作为测试接口。验证升级保真及失败回滚、发现/修改/不误增版、范围/停用/删除/回滚和无正文目录读取。单例到相关模块，不无条件重跑全量。

复用 npm run dev 热更新实例做真实 Skill 管理页检查；不打包、不发送外部聊天、不 push/PR。
