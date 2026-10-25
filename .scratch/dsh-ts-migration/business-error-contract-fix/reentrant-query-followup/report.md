# 重入查询错误来源修复

输入固定点 283a609f5f48503657bef571c0ea9539d4ee7b76。仅修改 host-storage.ts、原事务错误测试和本目录；源码/测试已冻结，未动 index 或提交。旧 finding、manifest、日志及所有前轮证据保留，不据本轮改写原 1491/1491 全量的字节绑定。

## 独立 RED

先重放原 Standards 探针。因主树没有 host-storage.baseline-review.ts，只将探针中这一项 import 指向仓库外 a102ae51 原字节源码；目标源码、其余输入、断言不变。适配摘要见 probe-adaptation.json。旧基线受控、继承配置通过，目标重入超时失败且 originalDriverErrorEscaped=true。新增同一永久反例也先 RED，嵌套查询和零写入均已验证。

## 根因及接缝核验

原调用后对 activeQuery/队尾的差分只能猜一个新 Query。参数在原生 submit/prepare/bind 中执行 toPostgres；该函数同步排入第二条正常查询后，队尾属于第二条，原活动查询被遗漏。

核对已装 pg 8.16.3 的 Client.query、_pulseQueryQueue、_handleReadyForQuery、Query.submit/prepare 和 utils.prepareValue。原生先构造 Query、安装超时，再入队并调用 _pulseQueryQueue；分发器先取队头再执行 submit。每次入队都会调用分发器，即使 readyForQuery=false，因此在原分发前观察整个待运行队列，同时覆盖重入前的外层 Query 和尚未分发就超时的 Query。

## 修复

- 只装饰本次事务 owned client 的 _pulseQueryQueue，在原生分发/submit 前为所有原生 pg.Query 注册既有错误来源观察器，随后按原 this/参数/返回值调用原分发器一次。
- 用 WeakMap 防止同一在途 Query 重复装饰，错误或 end 时恢复原描述符、移除监听并删除记录。
- 删除调用后活动/队尾推断；query 包装仅保留原返回身份和 Promise/同步驱动错误记录。
- 不复制配置、不包 callback、不改查询参数、连接、队列内容、Query.submit 或 wire；不新增业务查询、重试或范围读取。

这是锁定版本实现观察点的变化：_pulseQueryQueue/queryQueue 与既有 handleError/_canceledDueToError 都是 pg 实现细节，不冒充文档化公共 API。源码及版本 SHA 见 pg-source-pins.json，升级需重核验。没有修改第三方包或全局 pg 原型。

## 验证

| 验证 | 结果 |
| --- | --- |
| 原独立对照 RED | 2 pass、1 fail，目标原始 Error 外溢 |
| 本仓新反例 RED → GREEN | 各运行一次，稳定复现并修复 |
| 原事务错误模块 | 33/33，原32项全保留，0 skip，约10.77秒 |
| 原独立对照 GREEN | 3/3，目标 HostStorageError/database_unavailable，外溢为false |
| TSC noEmit | 退出0 |
| 精确补丁反向检查、空白检查 | 退出0 |

新增唯一用例覆盖 toPostgres 同步重入、外层回调超时、嵌套成功、各回调一次、原驱动 Error 不作为事务结果外抛，以及全部本人写入回滚。继承/非枚举、排队超时、this/结果身份、业务 Error/NotFound、只读、提交、关闭、unknown 与 Skill 原合同仍通过。没有全量或无关 SDK 矩阵。命令、阶段结果及原始日志 SHA 见 commands.json。

## 数据与交接

只用合成 PG/localhost 和本地夹具；0 真实资料、项目 .env、模型、App、微信或外部消息。未改预算桥、desktop/IPC/控制器、公开 DTO、账本实现或三份用户文件。全部 fixture teardown 通过，自有连接/数据库/临时目录已清理。原始证据仓库外0700/0600，诊断依赖链接已移除，公开材料脱敏并保留原始 SHA。

原核心、微信、Query、配置原型四组证据逐项摘要不变；原 Standards/Spec finding 不重写。root 按新 manifest 集成并复核，本轮不声称最终双轴已批准。
