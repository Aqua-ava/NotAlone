# 最终小修复独立 Spec 复核

结论：**approve**。在指定增量内未发现可确证的规格回归；不替代 Standards 轴，也不批准 Ticket 25／26。

范围固定为 `a102ae51548039f23a4a148fadb6cbe5a8bb9cc5` → `283a609f5f48503657bef571c0ea9539d4ee7b76`，仅三处执行逻辑和直接测试。来源与 SHA 见 `scope.json`、`manifest.json` 和 `SHA256SUMS`。

- **配置与回调**：`backend-ts/src/host-storage.ts:45–63` 原样转发参数；只从 pg 新建的活动／排队 Query 观察原错误分发，保留既有 Query 专用路径。锁定 pg 8.16.3 的安装源码 SHA 与作者清单一致。继承／非枚举 text、values、callback、冻结描述符和 getter 的独立原生对照通过；排队超时仍单次通知原回调、回滚并受控归类，业务映射异常保持身份。直接覆盖见 `backend-ts/test/business-transaction-errors.test.mjs:152`、`:182` 及 `independent.test.mjs:27`。
- **完成 DTO**：`backend-ts/src/pure-ts-public-api.ts:21–29`、`:64–65`、`:112` 仅投影 200 completed／generated 结果；准备回执、错误和读取讨论的嵌套结构继续保留。正式 JsonClient＋ReplySession 经真实本机 HTTP／合成 PG 直接发布三候选；丢回执、错 session／turn／input、换联系人晚结果保持原归属。独立在途取消拒绝晚输出保存；正式重试与继续客户端分别验证 restored_input、有效输入和要求字段。依据是 `.scratch/dsh-ts-migration/spec.md:28`、`:54`、`:72`、`:84`，直接回归见 `backend-ts/test/assistant-generation-publication.test.mjs:67–127`。
- **续期 ACK**：`bridge.py:51–92` 验证完整授权历史、最新有效授权、唯一活动新轮及新增轮上限；`:99–111` 将 ACK 保持为无预留的读取，check／reserve 继续走原门禁。15 项合成 SQLite 测试覆盖重复／满额 ACK 字节不变、原 deadline／计数／streak 不改写，及过期、旧轮、超额、损坏授权拒绝。依据是 `docs/agents/quality-diagnosis.md:16`、`:30`、`:36`；直接测试为 `.scratch/dsh-ts-migration/reply-budget-continuation/test_bridge.py`。

最终相关验证 **61/61**：业务 32、原生发布 5、公开回复 1、既有独立 Query 对照 3、预算桥 15、新增独立断言 5；单例复验不重复计数。命令、退出码及 raw/public SHA 全列于 `commands.json`。

首轮审查夹具失败均保留：网络限制误拦自有缺失 socket、补充夹具省略停止句柄／完整候选组、导出漏掉固定树 managed-runtime-contract。各自在单例修正夹具后通过；未修改产品源码，最终相关模块与新增独立断言均重跑通过。它们不是产品回归，原失败日志未改写。

本次未运行全量、真实模型、Electron/App／微信；未读取真实 .env、资料、原账本或私有模型输出。只使用自有合成数据库、SQLite 和回环供应商，网络限制传递给子宿主。未启动开发 App、打包、改生产／用户三文件／Git index、提交、push 或 PR；未创建子 Agent 或聊天。原始日志在仓库外 0700 目录／0600 文件，公开副本已脱敏，夹具清理结果见 `cleanup.json`。

用户已豁免的费用／输出门槛、deferred 记忆内容质量及原失败／unknown 均不重新裁定；本结论只覆盖上述执行增量。
