# Query错误来源小修复：Spec复核

结论：**request_changes**，1项P2。日期：2026-10-26。只覆盖 `dd97457bdd604fbda970c6eb0e5dc406ab1157bd` → `a102ae51548039f23a4a148fadb6cbe5a8bb9cc5` 的Query错误来源改动，不重审前次四模块或签收完整25/26。

## [P2] 配置回调复制丢失pg原生可读取的查询字段

位置：`backend-ts/src/host-storage.ts:60–61`，准确改动行为在61行。要求来自本次复核明确提出的“保留原PG合同”，以及迁移 `spec.md:54` 的“优先保持既有业务接口及运行时接口的输入、输出和错误语义”。

新分支把带 `callback` 的配置复制为 `{...config, callback: tracked}`。展开只保留可枚举自有属性，而锁定的 `pg 8.16.3` 原生会直接读取 `config.text`、`config.values`：`lib/utils.js:154–167` 保留原配置对象，`lib/query.js:12–15` 按属性读取。继承字段同样是该原生接口可处理的合法输入。如下配置在基线经真实合成PG返回17，在目标因text/values被丢弃而抛 `HostStorageError(database_unavailable)`：

```javascript
const config = Object.create({
  text: 'SELECT $1::integer AS value', values: [17],
});
config.callback = (error, result) => error ? reject(error) : resolve(result);
client.query(config);
```

独立同字节探针见 `query-probe.test.mjs:40–51`；`base-config-control.json` 为1/1通过，`target-probe.json` 在该输入失败。基线同时通过非枚举字段控制；目标在第一个继承字段输入即失败，未把后续未执行分支计为通过。请保留pg原配置的字段查找语义，同时记录回调错误来源，不用可枚举浅拷贝改变合法查询配置。

## 已确认保留的行为与证据边界

- 原Query普通驱动错误反例已修复；目标独立探针第1项通过并验证回滚。第3项验证Query成功后普通业务Error保持同一对象，即使带形似SQLSTATE的code。
- 固定目标 `business-transaction-errors.test.mjs` 独立运行30/30通过：NotFound、回调映射、Query返回值和回调身份、行解析错误优先级、取消、只读、连接、回滚／提交、关闭、unknown及公开Skill审批合同均保留。这不能覆盖上述新增反例。
- 原始／公开日志SHA及同字节输入SHA保存在每轮receipt；目标源码SHA和作者manifest SHA均与指定值相符。生产差异仅host-storage.ts；没有新的直接DSH接口改动。
- 本轮20个合成库及业务连接残留均0；只接本机合成PG，未读真实.env、模型或私有账本，App／微信／真实模型操作均0。未跑全量或typecheck，没有修改生产、任务状态、index或commit。
- 旧SHA清单所列23项冻结文件逐一校验不变；只新增本followup目录。质量继续deferred，输出／费用门槛豁免，实际值／unknown不改写；仅npm run dev且本任务未启动，不打包／push／PR／委派。
