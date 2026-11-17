# SQLite 混合检索索引

L0 聊天文字、联系人 L1 和本人 L1 共用本 Module。原始正文仍由消息／记忆保存；索引只保存身份、版本、正文摘要、分词表示和固定本机模型向量。它不创建联系人、不授予读取资格，也不向模型开放 SQL 或范围参数。

- `search.ts` 的 `rankReplyRetrieval(tx, request)` 是回复侧入口及本轮策略／覆盖状态的唯一返回点：接收宿主冻结的范围与瞬时 query 向量，先限定合法身份集合，再执行 FTS5 BM25、向量召回和共享等权 RRF。返回稳定身份及分数，回复 Module 负责定向物化、最终来源复验、预算与实际依据冻结。
- `actions.ts` 注册 `retrieval.pending`、`retrieval.syncTextBatch`、`retrieval.claimVectorBatch`、`retrieval.commitVectorBatch`。文本回填对无正文排队与旧分词身份去重后只探测批次上限加一项，返回实际处理数与必填 `scanMore`，不统计精确剩余数；额外一项不处理。向量领取只返回小批合法正文、删除代次与必填 `scanMore`，事务外本机推理后以摘要、代次和当前来源 CAS 接纳。领取游标不占用正文或阻止恢复；`scanMore` 只说明当前有限扫描段的后续页，不表示全范围覆盖齐备。精确积压数仍由 `retrieval.pending` 显式诊断查询，不附带在文本回填或向量领取结果中。
- `text-index.ts` 通过受控 writer 的 TEMP 脏身份触发器汇聚变化，沿 `flushDerived` 在同一业务事务内分词并更新 FTS；同步分词不调用模型。相同正文可复用既有向量，正文变化立即撤下旧表示；任何结清失败均回滚整个业务动作。
- `extension.ts` 只装载锁定的 `sqlite-vec`，随后关闭扩展加载。只读连接同样装载扩展，不能接受任意路径。`schema.ts` 的56固定保存已应用的初始索引与无正文回填队列，57追加游标及精确已知的未完成删除兼容；开库不处理全部正文或运行 embedding。
- `deletion.ts` 接入统一删除闭包，按历史域的真实消息删除目标及记忆实际依赖清理索引和队列，保留仍有替代来源的消息。FTS5 独立开启 `secure-delete=1`；vec0 的删除仅清有效位，必须先经正式 UPDATE 覆写向量槽，再 DELETE。现有删除维护继续负责 WAL／页与活动持有者清理。

分词与模型指纹都参与表示有效性；分词实现变化由相同小批回填入口修复，模型变化只重算不匹配的向量。query 和本轮分数不持久化。索引不完整时显式报告，不把未建齐的空结果当作完整未命中；无语义能力时沿 BM25 单路执行。

向量侧为 SQLite 本机精确召回，工作量随合法向量集合增长；它不承诺近似索引的次线性复杂度。FTS 的一次 MATCH 扫描、合法身份集合和 KNN 均须保持物化与查询计划约束，避免每个 posting 扫描合法集合或为每个身份重复执行 KNN。验证入口为 `test/retrieval-sqlite-index.test.mjs` 与 `test/retrieval-index-runtime.test.mjs`；同负载性能验收另按本次实际记录报告。
