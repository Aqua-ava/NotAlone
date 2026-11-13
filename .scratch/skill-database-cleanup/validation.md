# Skill 数据库精简验证

## 结果与数据影响

- 103 迁移移除 reply_skill_resource 整表及 8 个内容/重复元数据字段；只新增 manifest_sha256 完整性锚点。
- 描述、警告及资源索引由不可变版本根 manifest.json 提供；数据库保留身份、范围、启停、审核、版本、方法政策、来源删除及使用状态。
- 本机开发监督器自动执行103；再次运行公开迁移接口无待执行版本。实际库旧表不存在，8个目标列均不存在。
- 原5个Skill、5个v1和60个资源完整性均核验通过；未改Skill沟通内容，未读写聊天正文或发送外部消息。
- 热更新中间态误登记10个内容完全一致版本；逐一校验文档、清单及所有资源，并核验直接/JSON使用引用均为空后清理，保留原v1和来源。脱敏私有回执位于仓库外。清理后管理刷新不增版。

## 自动验证

- 红：新增公开Skill接口/结构回归，原实现因reply_skill_resource仍存在而失败；绿：同用例在103结构通过。
- Skill相关单元：`python -m unittest discover -s backend/tests/unit -t backend -p '*skill*.py' -q`，54通过。
- 完整目录模块：`python -m unittest discover -s backend/tests/integration/persistence -t backend -p test_postgres_skill_directory.py -q`，21通过。
- 消费者相关8模块75例，加探索、PG回复、来源删除及并发5例，共80通过；使用独立合成测试库与临时Skill目录。
- 数据库迁移19例、Skill历史升级6例、新清理迁移5例，共30通过。资源/方法损坏或SQL中途失败均回滚旧结构及内容，修复后可重试。
- 以上185例相关检查通过；额外定点验证清单损坏且工作正文变化仍拒绝自动增版、已删Skill脱敏展示、自动选版和方法筛选。
- `cd desktop && npm run typecheck`、Python compileall、`git diff --check`通过。未运行全量套件。

## Computer Use

- `npm run dev:status`确认复用当前项目热更新实例，无打包。
- 在实际App选择已有已确认联系人，打开Skill管理页，5个Skill全部启用、原v1可见；刷新后仍为v1。
- 最初选择无绑定的既有合成联系人时历史被拒绝；改用已有已确认范围后正常，未伪造绑定或扩大资料授权。
- 本次不涉及微信读取/发送变化，未操作外部聊天。

## 两轴审查

- Spec：无未解决实质发现；独立执行新迁移5例通过。
- Standards：发现清单损坏可能被当成工作目录修改而误增版，已改为拒绝并补回归；复审无阻塞发现。
- 排除其他并发任务的个人画像源码与测试改动；无远端操作。
