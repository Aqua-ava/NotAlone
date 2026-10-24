# 多 attempt 来源、报告器与盲评 subject 接线候选

本包属于 B 完整验收组件，不是 A 首次真实一对的前置条件。正式补丁只含 manifest 的 11 路径，基于已接收 reporter v3 的 `8de29d7210df33f5d5316883c97add347afff406`；不包含 usage 后续算法修正。

- `replyRuntimeSourceSubjectBinding` 仅接受已完成来源审计的结果；单 attempt 仍只返回原 `runtime_sources_sha256`，两种原 subject 公式逐字保持。
- multi 仅接 `constant_workspace_noSkill_read_denied_v1`，两次恒定 workspace/noSkill 来源及一次实际 read_file 拒绝过渡。公共 seam 核对完整 proof 字段、规范化 SHA、原 runtime SHA、有序 attempt ID/request/catalog 摘要与审计观察。
- `runtime_source_proof_sha256` 指来源审计生成的完整派生 proof，包含原 runtime、有序 attempt bundle、actual/partial/physical/transition 摘要；不代表采集历史认证，也不是仅声明自报值。`audit.binding_sha256` 与 `deterministic_checks.runtime_sources_sha256` 仍指原 runtime 整包。
- verified multi 的 `row.request_sha256` 和 timing 的同名绑定保持 null；只有实际来源审计和 seam 都成功后才豁免不存在的 single hash。原 count 仅延后检查，缺证据或未核验者仍记未知；单臂保留缺失分母。
- 非空 timing 的诊断模式只在完整来源 proof/bundle 核验后读取所有 attempt 的实际 stream。模式全部已知且相同才有 bool；缺失、不一致或未核 proof 不借首尾值。非流式已知 token 矛盾仍拒绝。
- 诊断报告单列 `runtime_source_proof_sha256`，不伪造单请求 hash；来源证明不补充阶段、首点或 COMMIT 实测。新增 timing 对照全是内存合成 unknown 声明，原 v4 捕获的 timing:null 未改。
- 盲包只有在已核恒定来源 proof 后才能取首 catalog；新增来源、成功工具读取和其它范围拒绝。callback 合法变化即使原 runtime 不变，也改变完整 proof 及盲/报告 subject，旧评审不能复用。

报告出口继续使用 v3 的固定合同元数据视图：`source_audit` 新增 contract_scope、完整 proof 的固定标量和有序三字段 attempt_bundle；diagnostics 只额外输出 proof 摘要。原 SDK request/output/body、actual、partial_observations、physical_attempts 等对象留在私有输入；原 output 摘要仍绑定完整 DTO，投影视图不冒充原证据。盲 visible 只增加受新 proof 影响的 opaque subject 摘要，不显示私密映射或来源身份。

新正式 v4 fixture 是已给定 `87fdbede4768298a40ca6e5ac7f2d79dcff70057b077cec46e4a5fc1e08c8d98` 捕获两条原 records 的完整封装，不是本轮新运行。两份评审仅为明确的独立合成 Agent 对照，不认证真人盲评。报告仍整体 undetermined、94 missing，固定 96 分母、数值阈值、语义硬门槛和两个认证 false 不变。

正式测试和资源均在 backend-ts 下，Node 24.19 普通文件快照可运行，不读取 .scratch 或依赖临时 symlink/node_modules。冻结 material manifest 内历史 source_path 文字保留原字节，运行时不跟随这些文字读取旧目录。strict 另用当前已安装 TypeScript 7.0.2 公共 API，仅读主树并叠加这两份候选源码，核对实际编译字节后 noEmit。

原 7/251/33/strict0 只归 history/pre-diagnostics；最终新增诊断 2 项通过后，仅重跑受影响 reporter+integration 87/87、strict0、仓外整合 9/9。source/盲/peer 92 对应模块字节未再变化，复用此前 251 覆盖，不宣称最终全 253 重跑。原失败载体漏 latency_ms 的日志保留，修的是合成载体显式 null；两次产品自然 red 和对应 green 均可按原始/公开 SHA 与行号复核。

最小重放：`node --test backend-ts/test/reply-comparison-multi-attempt-integration.test.mjs`；受影响模块：再加 `backend-ts/test/reply-comparison.test.mjs`。本轮 0 HTTP/PG/真实模型/App、无共享文件/index/Git 写入；作者未自签双轴审查或整体 05 资格。
