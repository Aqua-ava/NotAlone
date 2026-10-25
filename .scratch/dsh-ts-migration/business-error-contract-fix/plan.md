# 业务事务错误合同修复

- 基点：e60074b5946b8d1c990fcb75ba13bd58f789b2fb。
- 已授权接缝：HostStorage.businessTransaction / businessReadTransaction；生产 SkillLearningHttp 审批入口。
- 第一条 RED：已知 SkillLearningNotFound 保持同一对象，事务前置写入回滚，业务写入总数为 0。
- 第二层：真实 PostgreSQL SQL／连接错误保持受控 HostStorageError；未知异常不经 HTTP 暴露。
- 定向回归：缺失 comparison 的公开审批返回 404，draft 保持 pending/revision1，既有 Skill v1 不变，无模型调用。
- 生命周期约束：保持 close、回滚、取消、unknown 记录及错误时恢复原结果。
- 范围：仅指定源文件、新测试和本目录；不修改已有测试、不读项目 .env／真实资料、不操作 App／微信／真实模型／Git index。
- 不涉及直接 DSH 接口：HostStorage 是普通业务与 pg 边界，现有装配不变。
- 原始命令日志只在仓库外 0700 目录／0600 文件，公开摘要记录 SHA-256。
