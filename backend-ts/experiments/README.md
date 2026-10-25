# 回复候选离线盲评包

`build-reply-blind-packet.mjs` 将明确提供的合成采集分成可见呈现与私有绑定，不连接模型、数据库或网络。它接受本机假供应商采集和已完成、冻结的官方 DeepSeek 真实模型采集，并在可见包与私有绑定中如实区分来源；两种输入都不据此认证供应商真实性。两位评审者分别只读取 `visible/packet.md` 或 `visible/packet.json`；`private/` 保留原 DTO 摘要、运行身份和可逆别名，不随评审包分发。

在仓库根使用支持原生 TypeScript 的项目 Node 执行：`node backend-ts/experiments/build-reply-blind-packet.mjs CAPTURE_JSON DATASET_JSON NEW_OUTPUT_DIRECTORY`。输出目录必须尚不存在。公开回归材料是 `backend/tests/fixtures/fidelity/synthetic-v1.json`；测试夹具 `reply-blind-packet-pilot.json` 原样来自本机合成 SDK/业务/PG 采集，仅用于内部一致性验证。

工具保留全部候选正文、依据、风险提示、有序分段和引用来源全文，拒绝未知语义及原运行身份进入呈现。`bindSubmittedReview` 仅恢复调用者已提交评审的对象绑定，不产生分数或证明评审者独立性。失败记录和完整计划分母仍由原统一报告器处理，本工具不判定质量或生产切换资格。

真实供应商采集必须已经由独立运行器记录固定材料、同配置控制、实际请求、完整来源与持久结果；本工具只验证所给证据的内部绑定，不能把包生成成功视为真实模型质量、采集真实性或生产切换通过。

多次物理 attempt 只接来源审计已验证的 `constant_workspace_noSkill_read_denied_v1`：两次恒定 workspace/noSkill 来源与一次实际 read_file 拒绝过渡。首目录只有在这份恒定来源证明成立时才能用于呈现；新增来源、成功工具读取或其它范围不能据此接收。

报告器和盲包共用 `replyRuntimeSourceSubjectBinding`。单 attempt 的原 subject 公式保持不变；multi 另以 `runtime_source_proof_sha256` 绑定完整派生 proof，其中包括原 runtime、有序 attempt bundle、actual/partial/physical/transition 摘要。`runtime_sources_sha256` 仍指原 runtime 整包，记录的 `request_sha256` 保持 null，不用首尾请求摘要代替。callback 证据变化后须重新绑定评审，旧 subject 不能复用。
