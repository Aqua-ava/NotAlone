# 配置原型合同修复

本轮只修 a102ae51 Spec 复核确认的同一适配器回归。实际输入 HEAD 为 56a08f126364170ab829dcc105d83bda88b7c86b；目标两文件与 a102ae51548039f23a4a148fadb6cbe5a8bb9cc5 字节相同。仅修改 host-storage.ts、原 business-transaction-errors.test.mjs 和本目录。源码/测试已冻结，未操作 index 或提交。

## RED 与根因

先原样重放冻结独立探针，继承 text/values 的合法配置仍失败为 database_unavailable；新增永久回归也先 RED。浅拷贝只复制可枚举自有字段，改变了 pg 原生的属性查找语义。独立原 finding、manifest 和日志不修改。

## 最小修复与源码核验

已核对锁定 pg 8.16.3：client.js 的 query 在普通回调形式返回 undefined，不能直接从返回值取得 Query。它在返回前将原生新建的 Query 置于 activeQuery 或 queryQueue，提交错误延迟到 nextTick；超时先通知原回调，再在 nextTick 走 handleError。原生 Query 构造器直接读取原配置字段，支持继承和非枚举属性。

现在参数完全原样交给原 pg.Client.query，不复制配置、不替换 callback。普通回调返回 undefined 时，仅比较调用前后的活动 Query/队尾引用，找到该次原生新建的 Query，复用已通过 Standards 的错误分发观察点。队尾的新引用优先，避免误选已有活动查询。Promise 与显式 Query 路径保留原行为。

移除了 captureCallback 和配置浅拷贝；没有重新实现 Query 构造、配置归一化、Promise 或超时机制。没有改写 pg、SQL、连接或 wire 协议。

**实现依赖明确保留：** activeQuery/queryQueue 是锁定 pg 的客户端实现字段，本轮只读其引用；handleError/_canceledDueToError 是既有版本相关观察点。这些不是文档化公共 API，升级 pg 必须重核验。源码依据与 SHA 见 pg-source-pins.json，供小增量复核；不将测试通过当作免审理由。

## 验证

- 独立继承字段探针 RED 1/1；新增本仓合同 RED 1/1，随后 GREEN。
- 原事务错误模块 32/32、0 skip，约 10.13 秒，包含已批准的原 30 项和本次 2 项。
- 冻结独立探针脚本重放 3/3、0 skip；含原 Query 驱动错误、继承/非枚举配置，以及普通业务 Error 的原对象和回滚。
- TSC noEmit 退出 0；精确补丁反向 apply --check 与空白检查退出 0。未跑全量。

第一个新增用例同时执行继承/非枚举两份配置，覆盖活动与排队回调，返回 17，保留 callback、this、结果对象和 undefined 返回形状，不改变字段属性。第二个用例让配置回调在已有查询后排队并超时：原回调仅通知一次，this/参数个数沿用原生顺序，错误仍受控，本人写入全部回滚。原 Promise、显式 Query、身份、解析优先级、NotFound、取消/关闭、unknown 和 Skill 审批合同均通过。

## 范围与交接

只使用合成 PG/localhost；0 真实模型、App、微信、外部消息或真实资料，不读项目 .env，不做记忆质量调整。未改控制器、公开 DTO、预算 bridge、已集成微信测试或三份用户 desktop 文件。全部 fixture teardown 通过，自有连接/数据库/临时目录已清理；原日志仓库外 0700/0600，公开证据仅保存脱敏命令和原始 SHA。

原核心、微信 followup、Query followup 的证据逐项 SHA 核验未改；原 Standards/Spec finding 和日志继续冻结。root 负责按此 manifest 固定的源码/测试字节集成和复核。本轮不声称原 Spec finding 已独立批准。
