# Query 实例错误合同补齐

输入基点 ae12d7f1a407fc5852ae9c02d87253ded6828363。仅修改 host-storage.ts、business-transaction-errors.test.mjs 和本目录；旧核心证据、微信 followup、Standards 原 finding 保持，不修改其状态。未操作 index 或提交。本轮结果供 root 再做 Standards 增量复验，不自称已获独立通过。

## 已复现的缺口

读取 final-repair-standards-review/report.md 和冻结反例脚本后，以真实合成 PG 的同名不同 SQL 预备语句复现。初始五种形式中 Promise、位置回调受控，配置内回调、Query 内回调和 Query 事件路径暴露原始普通 Error。先前追踪只看末尾位置回调和返回 Promise，遗漏对象内部及事件分发；四表/业务写入不是原因，本轮各失败路径前置本人写入均已回滚。

另一个身份 RED 证明不能对所有带 then 的结果调用 then：原生 client.query(Query) 应原样返回 Query，即使对象自有 then。修复对显式 Query 直接返回原结果。

## 源码核验与实现

锁定已装 pg 8.16.3，未修改第三方包。依据 client.js:520 起 query 重载分流、query.js 的 handleError/handleReadyForQuery/submit、utils.js 的 normalizeQueryConfig 和实际类型声明，摘要见 pg-source-pins.json。Query 内回调错误不会发出 error 事件，故只加监听不能覆盖；直接替换 Query.callback 又会破坏排队中的引用和只读 callback 字段。

- 对 pg.Query 实例保留原对象、callback 字段和原生返回值。仅在该实例的错误分发入口记录实际错误；错误分发前、成功 end 或同步 query 抛错时恢复原属性描述符并移除清理监听。
- 对配置内回调使用浅配置副本，原配置 callback 引用不变，冻结配置也可用。位置回调保留 this、参数和结果，调用原函数前恢复驱动 Query 中的原回调引用。
- 不根据错误文案分类，不改变连接、SQL、wire 报文或原生回调分发，不重试。事务失败仍先回滚；真正驱动错误受控，业务 NotFound/普通业务 Error 保留原对象。

**版本耦合需增量审查：** handleError 和 _canceledDueToError 是 pg 实现细节，不是类型声明中的公开方法/字段。本轮只在锁定版本上观察错误来源，读取其原生优先分发的行解析错误，完整委托原生处理；没有改写解析标记或私有协议。入口缺失时受控失败。未来升级 pg 必须重新核验该入口和回归测试；这一适配点明确交 Standards 复核，不以测试通过掩盖依赖。

## 验证

| 验证 | 结果 |
| --- | --- |
| 初始重载 RED | 2 pass、4 fail，含父用例；三个缺口稳定复现 |
| Query 自有 then 身份 RED | 5 pass、2 fail，含父用例 |
| 最终错误合同与 host-storage 两模块 | 43/43，0 skip，约 13.70 秒 |
| TSC noEmit | 退出 0 |
| 冻结独立反例脚本由本轮重跑 | 四种形式全部受控，普通业务 Error 原对象保持 |
| 精确补丁反向 apply --check、空白检查 | 均退出 0 |

新增测试覆盖 Promise、位置/配置回调、Query 内/位置回调及事件形式；成功 Query、排队中 callback、callback this、end/回调/事务结果对象的身份；冻结配置与只读 callback；解析错误优先于后续数据库错误；Query 客户端超时和仅一次回调；驱动回调转换出的业务 NotFound 保留原对象。既有真实 PG、只读、取消/关闭、unknown 账本和 Skill 审批合同同组通过。完整命令、阶段退出码和原始日志 SHA 见 commands.json。

## 数据与交接

仅合成 PG、合成资料和 localhost/本地进程；0 真实模型、0 App/微信、0 外部消息，不读项目 .env 或真实资料，未做记忆质量调优。全部 fixture teardown 通过，自有 PG 客户端/数据库/临时目录已清理。原始日志在仓库外 0700 目录、0600 文件；公开副本不含本机路径，保留原始 SHA。

原核心 manifest 的六份证据、微信 followup 的八份证据均逐项 SHA 相同，已集成微信测试未编辑。原 Standards 报告、脚本及日志仅被读取或重放，原 finding 不重写。未跑全量；root 继续负责提交和增量 Standards 复验。
