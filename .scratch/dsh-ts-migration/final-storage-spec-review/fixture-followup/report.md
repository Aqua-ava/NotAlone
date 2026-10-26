# 测试夹具收尾：独立 Spec 只读复核

结论：`approve`。仅绑定`backend-ts/test/host-storage-fixture.mjs`补丁after SHA256 `ba09c57384e8d6b5632831db15257960258928e37c1f93db24d05c7ba0d89b82`；可登记规格偏离0项。输入manifest SHA256 `9d800e450226fddbc4f621294505bb8d3b92981b60899dc5c872c3c6fce4c91d`。不批准整体性能或25／26。

## 源码与范围

- 独立读取基线`b8ba6c6a1d2b428a9d749f2fe860fd2ac56c9597`和原检查点`1e90d9edde3a5c3ac0de08c018149dd79bbebdfc`的fixture，before字节均相同，SHA256 `121c074e43c0235b7ee434ab9478a96b3ec71b55bfb9dc0e40aca85d8273ae8a`。
- 原patch独立重建后与after逐字相同，仅新增7行；after读取前后摘要相同。before／after源码副本与补丁摘要见`binding.json`。
- `host-storage-fixture.mjs:11,27–30`：随机库名闭包必须符合完整`notalone_ts_host_<32hex>_test`，当前连接数据库也必须严格等于该名；不匹配即抛错，尚未终止或删除任何对象。
- `host-storage-fixture.mjs:31–32`：`datname=$1`参数化精确限制本轮库，排除`pg_backend_pid()`自身，且仅选`backend_type='client backend'`。没有终止其他库、共享PG或所有后台进程的分支。
- `host-storage-fixture.mjs:33–35`：关闭自身连接、原同步DROP及目录清理保留；新查询不吞错，终止返回值或失败不会被当作最终清理成功，原DROP仍须真正成功。没有修改生产池、权限、身份、来源或删除逻辑。

这符合本轮任务的测试资源归属和原失败判定范围，也保留`docs/agents/engineering.md:28`的合成夹具边界及`spec.md:62–65,101–103`的数据／生命周期合同。未增加额外验收门槛。

## 证据资格与保留结论

五份脱敏日志公开SHA已独立重算并与原件dualSHA声明关联；私有日志只保留相对locator与已声明摘要，未读取或复制其原件。root报告修后单例1/1、删除HTTP模块14/14、存储及业务错误57/57，0skip；本轮未执行测试，这些不能称本审查独立复现。

原600秒全量超时、单例hookFailed／ObjectInUse及原失败分母完整保留；修后完整全量仍为not_yet_run，不能用局部结果替代。root记录的自有TMP／库清理仅作为提供的证据引用，不冒充本轮实际连接PG核验。

六份生产／测试原审查文件当前字节与1e90检查点及v1 manifest逐项吻合，原六文件Spec approve保持该提交的既有适用范围。此补充仅批准上述fixture after SHA，任何后续源码变化再审；性能RED与25／26未批准状态不变。

本轮只读Git／源码／公开日志及摘要，只新增本专用目录；无测试、PG、宿主、App／微信、模型、新依赖或Git/index操作，不改产品、原冻结证据、任务状态或用户三文件。
