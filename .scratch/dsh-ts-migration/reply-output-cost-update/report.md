# 回复评测的输出与费用口径更新

状态：离线适配可审；Ticket 25/26 未批准。源码基点固定为 `bcc6701ce67249d18b51625c07f4cad4e401ad04`，本次评测与报告器增量单列；最终集成 pin 仍由根会话提供。

- 新策略为 [execution-policy.json](execution-policy.json)，绑定 [范围快照](scope-snapshot.md) 与原始 primary 的完整 SHA。只有 `max_output_tokens` 从 4096 改为 393216；材料、来源 ID、工具定义、oracle、temperature、top_p、thinking、stop、16×3×双臂、固定96分母及0自动重试保持。
- 官方 `/models` 文档于2026-10-25给出的 Flash 输出硬上限是393216，上下文容量是1048576；两者分别配置。文档依据：[DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/)。本机锁定 DSH adapter 版本为 `0.2.1-rc.2`，其 `lib/index.js:1719` 将显式 `options.maxTokens` 写入 wire；未修改框架。
- `run-full.mjs --execution-policy PATH` 将策略传入已有 collector。只在私有冻结 evaluation 副本调整 primary、旧臂输入预算 reserve/原计量器及 vendor guard；供应商转发从该冻结副本加载。新臂生成插件同步输出、已核实上下文容量与安全余量。每项适配均记录前后 SHA；候选源码仍明确标注唯一原始请求观察适配及 `matches_commit_tree=false`，不伪称纯 commit 树。
- `normalize.mjs --execution-policy PATH` 校验 capture、旧 profile、policy SHA，以及每一臂每一次实际 wire 字节、摘要和输出参数；只声明新配置而 wire 仍为4096会拒绝。无显式策略时保留历史4096合同，并拒绝带有新策略的采集。
- [report-current.mjs](report-current.mjs) 是本轮显式报告入口。它核验规范化策略、输出值及范围 SHA 后调用现有报告 API 的 `costWaiver` 参数。`cost_status=waived_by_user`，费用测量及历史1.10阈值结论照记，费用不参与本轮 overall；缺费用/价格保持 `null/unknown`。未传该参数时原默认保持。
- 回复链在 `reply-loop.ts:76` 使用普通 `beginCall`；来源核验 strict 是另一模型用途，本切片未改其配置，也未将普通回复 loopback 证据冒充 strict 实测。

验证按便宜到贵定点执行：新增8项行为测试分次通过；旧报告器默认回归78/78；隔离 bcc 源码加本次 scorer 的 `npm run typecheck` 与定点 `git diff --check` 通过。全部命令使用已指定 Node/Conda PATH，未运行全量套件或固定96采集。

真实的本机一对旧 SDK CC／官方 DSH Messages 经原业务和合成 PG 执行，两臂 wire 均为393216，各1次物理请求，来源 verified，五阶段完整。另一对注入503时，新臂仅1次请求，保留 failed、无持久结果、usage/cost=null；配置仍有24次物理余量，未依靠额度耗尽阻止重试。冻结 guard 的内存 ACK 探针证明查询不新增预留、复用同一 ACK 不能再次发送，缺价格的 relay 保留 usage/cost=null。

反证覆盖任一臂输出漂移、capture/profile/policy 不一致、最小pair冒充96、缺源pin或既有预算、质量/确定性失败、来源/配置/延迟 unknown、失败率及缺分母；费用豁免不能使这些条件通过。报告器 fixture 的96项只是原格式合成载体，未执行96次请求，也不代表独立盲评。

首次红测保留“无费用豁免状态”和“wire仍4096”。一次重复验证因已有证据文件 `EEXIST` 失败，原日志保留；后续目录采用唯一名称，未覆盖失败。所有私有证据仅在仓库外0700目录、日志/JSON为0600；公开路径使用占位符，完整 SHA 见 [verification.json](verification.json) 与 [artifact-manifest.json](artifact-manifest.json)。

数据影响：仅合成联系人、随机 `_test` PG、临时 profile 与 loopback；各 collector 自有数据库/profile/Python/宿主均清理。真实模型调用0、App/微信操作0、真实资料/账本/凭据读取0；未暂存、提交、push、PR或打包。闲置 archive、报告器副本和冻结 guard 副本在记录 SHA、核对无文件引用后已精确清理；占用从41060 KiB降到2804 KiB，原始证据保留。

局限：本次仅验证 bcc 加单列评测增量；未验证最终集成 pin，未运行真实96/盲评/实际桌面。协议与提示语义等价、真实模型响应版本及质量仍未认证；`arms_configuration_equal=false` 不因输出值相等而改写。

离线复现先运行 `node .scratch/dsh-ts-migration/reply-output-cost-update/prepare-archive.mjs "$PIN"`，从返回的私有 receipt 设置 `REPLY_OUTPUT_ARCHIVE`、`REPLY_OUTPUT_SOURCE_COMMIT`、`REPLY_OUTPUT_SCORER_FILE`、`REPLY_OUTPUT_RAW_DIR`，再运行 `node --test .scratch/dsh-ts-migration/reply-output-cost-update/output-cost.test.mjs`。每次使用新建 raw 目录；这会执行两对本机合成业务，不调用真实供应商。正式执行由根会话核验既有许可/累计账本/最终 pin 后分别向 runner、normalizer 和本轮报告入口显式传入同一策略，不为费用另跑对照。
