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

前台查询通过 `retrieval.coverage` 只探测当前范围是否存在待办或过期表示，发现首项即返回覆盖不足；`retrieval.pending` 的精确数量合同继续供后台与诊断使用。两者沿用相同 owner／contact、层级和模型指纹范围，不缓存覆盖状态。

后台单 lane 有界批次让查询优先；默认仍领取八条资料，由整批 holder 持有来源，全部推理完成后按原顺序一次 CAS 提交。神经网络推理按 Unicode 字符长度估算 padding 成本，每个子批控制在 512 个估算单位内；短文保持合批，长文或混合长短资料在子批之间让已排队查询先运行。该值是调度启发，不是 token 预算或硬时延上限，调度层不截断输入；取消、删除及关闭仍等待真实推理排空。

启动先回填 L1 小池，当前查询按联系人与层级唤醒，最多保留八个范围偏好，完成后继续全局 L0。游标按范围与层级隔离，扫描有固定上界、让出与有限退避。无效前缀不能永久阻塞后续合法资料，失败不能 busy 重试。FTS／向量分别按可用能力召回；缺本机模型降级 BM25，索引尚未齐备要明确覆盖不足。

向量领取以必填 `scanMore` 作为唯一继续信号，不同时维护精确剩余数。空页仍可继续越过无效前缀，到扫描尾则结束当前段；`scanMore: false` 不等于覆盖齐备，也不阻止后续唤醒。覆盖状态与精确诊断仍分别来自 `retrieval.coverage`／`retrieval.pending`。

## 删除与验证

来源、联系人、历史和账户删除覆盖分词表示、向量、待处理身份及游标。在途正文与 query 登记 ActiveHolders，删除等待真实推理排空；迟到向量须重新核对资格，不能恢复删除内容。FTS 独立 secure-delete、向量槽位覆写后删除，以及既有 checkpoint／VACUUM／校验共同完成物理清理。

测试以同一 Interface 核对字面／同义命中、RRF、范围与来源、持久复用、修订及删除／CAS；正式 DSH 的供应商替身测试证明工具和材料传递，不代表真实模型召回准确率。基准区分冷索引准备和热查询，不把合成向量时间当作真实 ONNX 推理性能。

覆盖探测的合成 SQLite 同负载对照可运行 `node test/fixtures/retrieval-coverage-benchmark.mjs`：比较 1 千／1 万／10 万条派生表示在文本排队、向量回填和全部齐备时的计数与探测，交错测量各 15 次。该基准包含真实 SQLite 查询与准入检查，不含业务来源核验、Worker IPC、ONNX 或外部模型，不代表完整回复耗时。

领取合同对照使用 `node test/fixtures/retrieval-claim-benchmark.mjs --compare-actions-module /绝对路径/固定旧动作.mts`，不传对照模块时只报告当前实现。同一合成 SQLite 中保存 48 条文字和两条人工记忆，每批领取八条，逐页核对身份及继续信号；收敛前后结果和游标写入次数一致：

| 范围 | 页数／领取身份 | SELECT 次数，旧 → 新 | COUNT 次数，旧 → 新 |
| --- | --- | --- | --- |
| 全局 | 7／50 | 368 → 347 | 21 → 0 |
| 当前联系人及本人 L1 | 1／2 | 33 → 30 | 3 → 0 |
| 当前联系人 L0 | 3／24 | 171 → 162 | 9 → 0 |

这里只移除了每次领取附带的三次精确计数；表中数字不含诊断主动调用 `retrieval.pending`，也不含 Worker IPC、ONNX、外部模型或耗时比较，不据此推断整体回复速度。

调度基准使用固定本机真实 ONNX、CPU 两线程和合成存储代理。以下命令在 `backend-ts` 下运行；前者测当前运行时，后者在同一个已预热模型会话内与固定旧模块逐样本交错对照。输出双方源码摘要、实际 token 数、闲时与忙时查询、排队、回填和模型工作量；`--runtime-module` 也可单独指定固定模块。

```bash
node test/fixtures/retrieval-scheduling-benchmark.mjs --samples 20 --batch-sizes 8 --workloads short,long,mixed
node test/fixtures/retrieval-scheduling-benchmark.mjs --samples 20 --batch-sizes 8 --workloads short,long,mixed --compare-runtime-module /绝对路径/旧运行时.mjs
```

本机同会话对照每组 20 个样本，双方每轮使用同一组八条合成资料，代表结果如下。时间单位为毫秒；忙时查询在首次后台推理发起后提交，后台列是没有查询时处理八条资料的总耗时。

| 负载 | 忙时查询 p95，旧 → 新 | 无查询回填 p50，旧 → 新 |
| --- | --- | --- |
| 短文 | 6.782 → 6.899 | 5.290 → 5.402 |
| 长文 | 135.025 → 18.812 | 132.604 → 132.752 |
| 长短混合 | 135.463 → 15.171 | 131.328 → 58.121 |

短文基本持平；长文减少前台等待，混合负载同时减少 padding 成本。双方共 120 次忙时查询均使用混合检索，没有耗尽五秒预算。该对照包含分词、张量构建、ONNX 和归一化，不含 SQLite、业务来源核验、Worker IPC 或外部模型，不能换算成完整回复速度。

字符估算也有保守代价：附加的 `--workloads ascii` 使用每条约两千字符但仅三个 token 的极端 ASCII 字符串，同会话 20 轮中，八条无查询回填 p50 从 3.507ms 增至 11.548ms。该负载会被拆得偏小；调度启发不保证所有文本形态的后台吞吐都提升。
