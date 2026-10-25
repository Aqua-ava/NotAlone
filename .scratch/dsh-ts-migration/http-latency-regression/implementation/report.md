# HostStorage HTTP 延迟诊断与局部优化（2026-10-26）

已冻结，保留局部优化供 root 集成；HTTP 性能仍未闭合，不批准25/26。这里全部是 HTTP-only 与有限事务诊断，未执行完整40次启动／60秒RSS协议，不能据此生成正式总体性能结论。

产品改动仅两处：`backend-ts/src/host-storage.ts:254` 和既有已登记的 `backend-ts/test/host-storage.test.mjs:291`。源码从 HEAD `54aebef5ccad427d680ce243eb852c5bd4d91f1e` 起步；相关生产代码与冻结 `e5d8183bff811bc9bdd466a3035deb0b6abf10e3` 一致。产品补丁及逐文件基线／当前SHA见 `product.patch`、`product-bindings.json`。

根因反馈是 `storage-loop.mjs` 的真实 `businessReadTransaction(SELECT 1)`：每轮随机合成_test库，单并发，10次预热、30次计分，完整保留所有样本。原源码 p50 6.9318ms，为诊断用5ms阈值下的RED。此阈值只用于有限反馈，不是预注册性能门槛。最小重现保留真实116份迁移、账本与结构合同，未用假PG或删检查缩短路径。

已先提出并分别测量文件I/O、全catalog、连接收尾和SET往返。原源码临时副本的owned-client trace（原始样本 `storage-trace.json`，汇总 `diagnosis.json`）中，`inspect` p50约4.486ms，其中全量文件读取／哈希1.762ms、catalog1.197ms；连接0.942ms、结束0.710ms，三个SET各约0.016–0.026ms。这些时间不能简单相加视作严格分解，GC和调度仍在外层时间内。

负载完全相同的文件I/O小样中，promise／callback／同步读取p50约1.246／0.890／1.068ms，116份字节哈希全相同；catalog object／array／聚合小样约0.490／0.489／0.551ms。收益不足或无收益的替换没有进入产品。

最小修复只让相互独立的SQL文件哈希与当前事务catalog读取并行；`Promise.allSettled` 保留文件错误优先级，等待catalog完成后才判定／收尾。全部116份文件仍逐次读取字节并哈希，账本、035基线、所有原结构／约束合同及错误返回继续逐次检查，没有成功结果缓存。

连接配置、TLS升级／降级、事务初始化／COMMIT／ROLLBACK／关闭屏障、唯一写者及 `trackQueryFailures` 均逐字未变（见 `product-bindings.json`）。未改pg配置／回调／参数／thenable处理，未改业务Error与SQL错误的归属，也未改变owner+contact范围。新测试验证暖读后同大小／同mtime的SQL篡改、读取文件变成目录均失败关闭，恢复后重新成功。它是安全回归；旧版也通过，不冒充性能RED。

真实产品初次GREEN为4.7911ms；冻结前最终同源小样为5.0260ms，再次略超诊断阈值，未重跑选优。两轮均保存且资源清理通过。最终源码SHA与HTTP after的冻结副本完全一致；不能只用初次GREEN宣称问题已解决。

HTTP重新克隆同一个冻结合成dump，对before与after各完整执行旧／新两臂：每例10预热+30计分，三例、四个宿主共480请求，全部成功；160次写入结果回读全部成功。顺序固定为before-old、before-new、after-old、after-new，并发1，没有重跑输臂或删异常值。源码379个文件逐项绑定；before与after只有 `host-storage.ts` 不同。旧源码、依赖、Node／Python二进制、dump和原工具前后哈希均通过核对。

| case | TS before p50 ms | TS after p50 ms | 同轮旧臂after p50 ms | after p50比 | after p95比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| contacts | 8.6863 | 6.6548 | 1.8430 | 3.6109 | 3.6305 |
| sources | 7.7170 | 7.5046 | 1.3106 | 5.7261 | 6.1598 |
| session-default | 12.2853 | 10.4317 | 2.8137 | 3.7074 | 3.7715 |

contacts与session-default有局部改善；sources的变化不足以宣称改善。重算直接沿用冻结统计器的HTTP阈值 p50=1.15、p95=1.25、seed102与10000次成对bootstrap：after三例p50/p95诊断门禁全部failed，详见 `http-diagnostic-statistics.json`。`http-recheck-summary.json` 的粗差异标志不替代该预注册统计器，更不代表完整总体协议。

本轮两臂均仅观察HTTP响应边界，没有全局patch pg／psycopg query或包装查询callback；写入通过独立HTTP回读确认，内部COMMIT耗时未测。与root-preflight的PG/异常观察方式不同，因此前后效果只比较本轮before/after配对，不能把root冻结数值当作本轮before。root-preflight-summary保持原样。

运行环境为Node v24.19.0、Python 3.12.15、pg8.16.3及原锁定DSH版本；未安装依赖。每臂原配置在before/after保持，旧／新事务设置本来不同。独立合成库设置探测见 `settings.json`：旧contacts式连接默认read committed、read_only off、超时0；新只读为repeatable read/read_only on，写事务仍read committed；新search_path、3s statement timeout、1s lock timeout均未改。其他旧路由的逐连接设置未冒充实测。采集元数据中一个歧义字段已在规范化副本修正，原capture完整保留；`metadata-correction.json` 证明全部480行计时／失败／绑定未改。

实际验证命令（`$NODE`指冻结计划已核验的Node，`NOTALONE_TEST_PYTHON`指授权的旧隔离venv，测试不读原.env）：

- `$NODE .../storage-loop.mjs`：原RED、初次GREEN及最终RED均保留，不据此降低门槛。
- `$NODE --test --test-concurrency=1 backend-ts/test/host-storage.test.mjs backend-ts/test/business-transaction-errors.test.mjs backend-ts/test/model-call-receipt-migration.test.mjs backend-ts/test/model-call-learning-claim-migration.test.mjs`：82/82，0失败、0跳过；包含原Query重载、只读callback/config、重入、行解析、query timeout、业务Error、回滚、关闭排空合同。
- `$NODE --test --test-name-pattern='每次业务读取重新核验全部SQL字节' backend-ts/test/host-storage.test.mjs`：最终1/1。
- `$NODE backend-ts/node_modules/typescript/bin/tsc --noEmit --project backend-ts/tsconfig.json`：通过；`git diff --check`：通过。环境没有npm，首次npm调用exit127保留在 `typecheck.log`，随后使用仓库已装tsc，未安装替代工具。
- 旧隔离Python执行 `http-recheck.py`：480/480，无模型；`summarize-http.py` 仅分析保存样本，不新增请求。

只处理授权的冻结合成子树、自己的随机_test库／目录与仓库产品代码。HTTP四宿主退出身份核验均通过、四库DROP成功，全部自有work/profile/raw目录已移除；最后设置探测另核验0残留会话和库不存在。测试fixture也完成DROP／目录清理。Node／Python出站拒绝记录0、model_call_receipt与outbound_ledger_entry均0、embedding缓存文件0；未访问实际App／微信、原资料、原.env、用户backend-launch、模型或预算。原冻结目录未改，临时源码和node_modules链接已清理。

已串行自检，不冒充独立Agent审查；本次没有新Agent/chat、App启动／打包、index/add/commit/push或远端操作。所有改动保留为可审查未提交状态，由root独占集成。数据处理范围、公开扫描及文件SHA见manifest；root可按staging-manifest选择本任务文件。

剩余退化是真实的：完整逐事务核验和连接收尾仍有明显成本，优化没有把新HTTP恢复到旧臂。后续若要继续优化连接生命周期，仍须保留受控TLS、owned-client观察器清理、故障连接淘汰、原Query身份／回调／重入／超时合同与关闭屏障；本轮没有实施该方案。25继续claimed、26未开始；真实App／微信、完整启动／RSS及其他未豁免要求继续由root验收。
