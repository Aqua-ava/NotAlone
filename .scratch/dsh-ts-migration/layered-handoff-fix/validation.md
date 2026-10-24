# 分层事务指纹修复独立归档

## 问题与行为

09实际App纠错后，TS失效原概览缓存，Python分层读取仍从缓存表取manifest而出现503。修复在同一事务读取概览时绑定完整dependency_manifest，分层消费者只采用这份当前指纹；缺失或身份不匹配则拒绝。公开概览DTO不序列化内部字段，不恢复Python缓存写入。

## 归档边界

仅memory/overview.py、persistence/memory_overview.py、persistence/layered_memory.py和test_layered_handoff_manifest.py；ContactContextHandoff与其余依赖已在HEAD，不包含05端口、09服务及共享宿主。此修复没有新增DSH API，沿用已锁定0.2.1-rc.2官方profile及既有迁移接线；查证见memory-preferences记录和runtime-validation资料。

## 证据

- Standards/Spec追加只读审查均0 finding：memory-preferences/review.md“分层事务指纹修复追加审查”。
- 先前工作树Python新旧相关7/7、09后端相关37项（含官方profile用例）已通过；本轮真实App纠错/依据/版本/删除已通过并清理，见memory-preferences/validation.md最终复验和根app-resumption-20261024.md。
- 为证明独立提交闭合，用Git HEAD的backend归档加且仅加上述4文件构造临时树，不复制其他未提交产品；固定Conda Python，运行 `python .scratch/dsh-ts-migration/layered-handoff-fix/verify-independent.py`，两个unittest模块7/7、0skip，4.732秒。
- 覆盖缓存缺失/陈旧、指纹缺失拒绝、旧任务失效和迟到发布拒绝、owner/contact隔离、公开DTO白名单及旧capture可用性。
- 只用随机_test PG、独立managed目录并禁用dotenv；随机库和临时树已清理，无真实资料、模型、App启动或打包。共享PG保持运行。

该提交只归档已修复的过渡读取问题；不表示09整票、05依赖或最终HEAD完整集成验收完成。
