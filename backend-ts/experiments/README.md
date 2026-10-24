# 回复候选离线盲评包

`build-reply-blind-packet.mjs` 将明确提供的本机假供应商完整合成采集分成可见呈现与私有绑定，不连接模型、数据库或网络。两位评审者分别只读取 `visible/packet.md` 或 `visible/packet.json`；`private/` 保留原 DTO 摘要、运行身份和可逆别名，不随评审包分发。

在仓库根使用支持原生 TypeScript 的项目 Node 执行：`node backend-ts/experiments/build-reply-blind-packet.mjs CAPTURE_JSON DATASET_JSON NEW_OUTPUT_DIRECTORY`。输出目录必须尚不存在。公开回归材料是 `backend/tests/fixtures/fidelity/synthetic-v1.json`；测试夹具 `reply-blind-packet-pilot.json` 原样来自本机合成 SDK/业务/PG 采集，仅用于内部一致性验证。

工具保留全部候选正文、依据、风险提示、有序分段和引用来源全文，拒绝未知语义及原运行身份进入呈现。`bindSubmittedReview` 仅恢复调用者已提交评审的对象绑定，不产生分数或证明评审者独立性。失败记录和完整计划分母仍由原统一报告器处理，本工具不判定质量或生产切换资格。

当前版本只支持本机假供应商采集格式；真实供应商运行的接收格式及实际语义评审仍需单独验收，不能把本工具成功呈现视为真实模型通过。
