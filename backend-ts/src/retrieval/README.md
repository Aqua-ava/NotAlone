# 本机混合检索 Module

L1 已采纳记忆和 L0 获准聊天共用 BM25、向量与 RRF。范围及删除合同见 [ADR-190](../../../architecture/adr/190-tencent-style-local-hybrid-retrieval.md)与[回复规格](../../../architecture/current/reply-generation.md)。检索表示是可重建派生数据，不能成为事实源。

## Interface 与职责

- `search-tokenizer.ts`：写入／查询共享 jieba 搜索分词和可辨认的回退指纹；查询构造带引号的 OR 词项，不接收 FTS 查询语法。
- `hybrid-ranking.ts`：等权 RRF、k=60，合并稳定身份的两路名次；不混加 BM25 与余弦原始分数。
- `sqlite/search.ts` 的 `rankReplyRetrieval`：可信调用方传 owner、contact、query、瞬时 query 向量与冻结范围，返回有序身份、实际策略和索引覆盖状态。合法身份集合在两路 top-K 前限制；复杂 L1 来源／时间资格通过可信领域回调核验，发现无效项则排除后重新召回，不能让固定倍数候选挤掉合法尾部。不接收模型指定的身份或 SQL。
- `index-runtime.ts` 的 `createRetrievalIndex`：普通 TS 生命周期，复用已准备的本机 embedding；`start` 不等待全量回填，`queryVector` 只处理查询文字，`close` 等待真实在途推理结束。`flushForTests` 仅用于隔离验证的有限排空。
- `sqlite/`：同业务 SQLite 的 FTS5、sqlite-vec、无正文待处理身份、受控具名动作及删除 domain。连接固定加载扩展后立即关闭加载权限；事务不等待推理。

回复 Module 只将两层范围适配为共享检索请求，按身份读取当前正文、执行联系人／本人及消息预算、冻结实际来源。目录、未返回候选和索引准备不算模型已读；DSH 仍通过官方 scoped Tool 与 Agent loop 执行下一轮。

## 索引维护与效率

初始迁移 56 只登记既有资料身份，57 追加游标及旧删除清单兼容，正文分批建立索引；历史迁移及校验和保持原样。新写入／修订通过 TEMP dirty 聚合，由存储 Worker 在提交前执行确定的 JS 分词与索引 SQL；不用触发器调用 JS UDF。FTS 与权威写入保持原子，向量在事务外小批生成并 CAS 提交。正文未变时复用向量，模型指纹变化时分批重建，不做跨联系人正文 hash 缓存。

后台单 lane 有界批次让查询优先；启动先回填 L1 小池，当前查询按联系人与层级唤醒，最多保留八个范围偏好，完成后继续全局 L0。游标按范围与层级隔离，扫描有固定上界、让出与有限退避。无效前缀不能永久阻塞后续合法资料，失败不能 busy 重试。FTS／向量分别按可用能力召回；缺本机模型降级 BM25，索引尚未齐备要明确覆盖不足。

## 删除与验证

来源、联系人、历史和账户删除覆盖分词表示、向量、待处理身份及游标。在途正文与 query 登记 ActiveHolders，删除等待真实推理排空；迟到向量须重新核对资格，不能恢复删除内容。FTS 独立 secure-delete、向量槽位覆写后删除，以及既有 checkpoint／VACUUM／校验共同完成物理清理。

测试以同一 Interface 核对字面／同义命中、RRF、范围与来源、持久复用、修订及删除／CAS；正式 DSH 的供应商替身测试证明工具和材料传递，不代表真实模型召回准确率。基准区分冷索引准备和热查询，不把合成向量时间当作真实 ONNX 推理性能。
