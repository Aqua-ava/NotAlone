# 宿主夹具清理收尾证据

本轮原5个失败全部完成 RED→GREEN：干净环境逐例0/5→5/5；最终直接相关5文件31/31，43.695秒，skip/cancel/todo均0。证据固定在下方生产源码SHA，不代表后端全量或任务25/26签收。

## 根因与修复

`host-storage-fixture.mjs:27`新增了通过自己活连接执行`current_database()`的范围核验。回复夹具与重连夹具原来先`client.end()`再`f.close()`，因此三项回复清理都报`Client was closed and is not queryable`；重连还追加库/目录未删错误，掩盖故意排空失败的原`ERR_ASSERTION`。完全移除两种API key后仍能逐项复现，与root另管的collector环境问题不同。

- `backend-ts/test/reply-fixture-cleanup.mjs:52`：确认宿主与provider正常收尾后，先让`f.close()`使用活连接完成核验、排空、end和删除；最后独立end兜底。任何失败都不记为`cleaned`。
- `backend-ts/test/sync-incremental-reconnect-fixture.mjs:54`：保留原业务连接数断言，随后由`f.close()`回收，最后end兜底；保留宿主退出、库/目录删除和重复close原异常断言。
- 两个`reply-*-cleanup.test.mjs`按root明确授权更新正常mock的活连接契约，新增dispose失败与client晚失败的原异常/状态回归。强退、超时、身份未知、provider失败、多异常与应保留现场的全部原检查仍通过。

共享存储fixture保持SHA `ba09c57384e8d6b5632831db15257960258928e37c1f93db24d05c7ba0d89b82`。本任务未修改生产代码；验证前后`backend-ts/src/host-storage.ts`均为`0c96568ae4d608beda97af03bbaba696f07148627ecae153b1692dc52ee94f25`。

## 命令与分母

全部命令在`backend-ts/`运行，由私有白名单runner设置自有TMP/HOME、已批准Node/Python工具和localhost假模型；两种API key字段均不存在。`verification.json`保存每轮完整Node参数、计数、时长和原始日志SHA；完整私有实参与路径仍留在私有invocation记录，不复制到公开证据。

```sh
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=B5-02 test/reply-arbitration-handover.test.mjs
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=B5-03 test/reply-arbitration-handover.test.mjs
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=B5-01 test/reply-background-public.test.mjs
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=全局流code7 test/sync-incremental-reconnect.test.mjs
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=排空断言失败仍回收 test/sync-incremental-reconnect.test.mjs
$NODE --import "$PRIVATE_TRACE" --test --test-concurrency=1 --test-name-pattern=. test/reply-fixture-cleanup.test.mjs test/reply-background-cleanup.test.mjs test/reply-arbitration-handover.test.mjs test/reply-background-public.test.mjs test/sync-incremental-reconnect.test.mjs
```

原5单例逐项RED与GREEN，新增异常传播单例2/2，直接模块6/6，最终相关模块31/31。修复中的旧mock顺序曾为17/23，6失败及原日志完整保留；更新后最终31例中均已转绿。另有2次诊断准备误差已明确排除：一次缺少PG所需USER、一次名称pattern无匹配，均不纳入有效通过分母。

## 数据与剩余边界

只处理自有合成数据。RED遗留5库/5目录按trace、合成配置中的库名、连接0和自有PID退出证明逐一回收；最终自有库、client、已记录进程残留均0，两个自有短TMP根已删除，两轮隔离vacuum夹具也自行验证库/cluster/目录已删除。清理只使用本轮归属集合；root提到的4个旧测试库和120个旧目录未枚举、未删除，不能据此判断它们当前状态。

未启动实际App/Electron/微信、未打包、未运行真实模型、未安装依赖。未读取原用户资料/配置/预算/密钥；三个原用户测试改动保持原状。原始日志在0700私有目录、文件0600；公开证据不含私有绝对路径或OS用户名。

本任务没有提交、暂存、push或PR。root另管collector与skill-host收尾，backend full在此处未重跑；记忆质量、模型费用、OCR、任务25/26状态不由本任务变更。精确集成文件清单和SHA见`staging-manifest.json`与`SHA256SUMS`。
