# 06 Python移交基础验证（2026-10-24）

已按根明确授权应用skill_library.py、skill_directory.py局部补丁；默认全局门仍python，不在生产调用stop/activate，不修改公开ownership。普通管理_connect保持所有调用点既有with语义，租约涵盖连接提交/回滚/关闭；仓库检索无跨模块直接调用或patch PostgresSkillLibrary._connect。publish_reviewed/rollback_locked保留调用方事务，不经过普通管理门；15仍是这两类事务的唯一写者。

## 实际验证

- 固定解释器：$HOME/miniconda3/envs/NotAlone/bin/python。
- backend内 `-m unittest tests.unit.persistence.test_skill_management_handoff tests.unit.persistence.test_skill_management_remote -v`：18/18，6.081秒。
- scratch/run_python_regression.py `tests.integration.persistence.test_skill_management_handoff`：3/3；合成真实PG验证原状态、排空、远端错误不本地发现、只读check_only、停收后15持锁回滚仍可执行。
- 同runner单例先跑普通导入：1/1。
- 同runner相关模块：test_postgres_skill_library、test_postgres_skill_directory、test_postgres_skill_lifecycle、test_postgres_skill_preview、test_postgres_skill_export、test_postgres_skill_deletion（均integration.persistence）；test_skill_review、test_skill_lifecycle（integration.server）：116/116，73.563秒。覆盖原审核发布/历史回滚与来源删除，日志中预期拒绝异常不等于测试失败。
- git diff --check（两个修改文件）通过。

## 审查修复

1. 取消之后HTTPConnection可能自动重连：真实socket加Event发送边界先RED，close与deadline两分支均能复现；显式设置auto_open=0后GREEN，停止后未发出RPC。Standards复核已关闭P2。
2. chunked trailer绕过解码正文预算：14字节JSON加32KB trailer先RED；内部RPC协议拒绝Transfer-Encoding，宿主需Content-Length或关闭定界，修复后GREEN。服务端必须按此明确协议装配，不能默认分块响应。

## 数据与范围

所有资料为合成内容；runner创建随机notalone_skill_handoff_*_test库并在finally DROP，自有临时目录退出删除；目录/HTTP原测试的自有库按原fixture清理。只复用主会话PG，不关闭集群。无真实聊天、模型调用、App或微信操作。未git add/commit，等待Git独占；禁止push/打包，App仍需单独租约。

## 仍未完成

共享app/command/host仍09独占；内部RPC服务端鉴权、固定owner配置、stop/drain/activate装配、TS公开路由与fileHealth、05来源C完整守卫、官方profile HTTP及真实App仍待接通。HTTP所有权测试仍未GREEN，不将116旧Python测试当TS迁移完成。legacy-write-handoff.patch保留为本次已应用的审查记录，勿重复应用。

Spec复核亦已关闭两项finding，并以独立createStorageFixture新建随机_test库重跑21项（18单测+3PG）通过，无skip。Standards/Spec当前未关闭finding均0。
