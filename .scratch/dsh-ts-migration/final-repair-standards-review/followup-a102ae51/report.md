# 原 P2 修复的 Standards 小增量复核

结论：**approve**。原 Query 实例异常漏追踪 P2 已在本固定增量关闭；未发现新增阻塞。范围仅为 `dd97457bdd604fbda970c6eb0e5dc406ab1157bd` → `a102ae51548039f23a4a148fadb6cbe5a8bb9cc5` 中 `backend-ts/src/host-storage.ts` 的修复及必要测试，不签收整个迁移或 25／26。

核对所得：

- `host-storage.ts:21–27,58–61` 覆盖位置回调和配置内回调，以原错误对象登记来源；配置内带回调时复制配置，成功回调按原 `this` 调用，并在直接分发时恢复 callback 身份。
- `:29–49,56,65` 对 Query 本体追踪 `handleError`，不替换 Query 或内部 callback；直接返回原 Query，不误消费它的 `then`。成功结束及错误分发均清理追踪监听，并恢复原方法或原属性描述符。
- `:43` 与锁定驱动 `pg/lib/query.js:122–138` 保持相同优先顺序：已保存的 `_canceledDueToError` 优先于随后数据库错误，登记实际传给 callback／error 事件的对象。`:247–253` 的回滚、领域异常筛选和关闭逻辑未改变；调用方另行转换的领域异常仍保留原对象。
- 该适配器明确依赖 **pg 8.16.3 的内部实现**，不是公开 API 保证。固定源码、package、lock、实际安装版本一致，源码及作者 manifest 明示 `handleError`、`_canceledDueToError` 和升级需复验；本次认可限定于该锁定版本。

独立实际复验：直接复用此前冻结的原反例脚本，Promise、位置 callback、配置 callback、Query 内 callback 四种形式全部返回 `HostStorageError/database_unavailable`，普通领域异常身份保留。另有 3 项独立检查通过：事件式行解析错误优先及回滚；只读 callback、Query／this／结果身份、then 不被消费及描述符恢复；驱动错误经调用方转换后保持领域对象并回滚。见 `original-finding.public.log`、`dispatch-boundaries.public.log` 和 `verification.json`。

已校验目标源码 SHA：`8b3f974caa1afa495b4cae58c8b9e57c74bd1b0c0f3beb98df9300a4497d9e11`；指定修复 manifest SHA：`d7b8223fcd8875e13c2e4e4b9cda62a5a3eff8556fd84e61e9bb994d0847830f`。作者 manifest 记录其制作时的较早 Git 位置；本复核以本次两个固定树及实际文件字节为准。

只使用隔离 archive、合成 `_test` PG；数据库和连接均随夹具收尾。无真实模型、私有账本、项目 .env、App 或微信访问；无生产、任务状态、index、commit、push、PR 或打包改动。仅新增本目录，旧报告／反例／manifest 均保持原冻结状态。未重跑完整模块、全量或 TSC；根及作者报告的验证不计为本会话执行。记忆内容质量保持 `deferred_by_user`，输出／费用门槛豁免和实际值／unknown 不变。
