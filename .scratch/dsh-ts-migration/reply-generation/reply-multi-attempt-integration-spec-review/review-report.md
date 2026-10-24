# Spec 独立审查

确认 finding：**0**。未发现本组件要求缺失／部分实现、未请求扩展或行为错误。

对象为未应用的冻结 `candidate.patch`（SHA `c2dc61e96cda6fed54dc79edfe83f220ffef16fe848317fe78307059d89c6f3d`），以 `8de29d7210df33f5d5316883c97add347afff406` 为给定基底；这是 WIP 补丁审查，不是 Git 三点提交差异。下述候选行号均指本包 `formal-tree/backend-ts/`，合同路径相对 `reply-generation/`。

- 冻结合同 `reply-multi-attempt-source-integration/contract.md:5` 要求 single 公式保持，`:6` 要求完整 proof／有序 bundle。候选 `reply-comparison-sources.ts:279` 校验审计状态、完整 proof 字段及规范化 SHA，并逐序核对 attempt ID／request／catalog；source v2 主体逐字保留。
- 合同 `contract.md:8`、`:11` 要求只有 verified 才豁免 null single hash，callback 变化须重绑评审。候选 `reply-comparison.ts:253`、`:267`、`:293` 和 `reply-blind-packet.mjs:77`、`:98`、`:103` 共用同一 seam；未核来源仍未知，旧 subject 会被评审绑定校验拒绝。
- 合同 `contract.md:9`、`:10` 要求完整已知 stream 及保守诊断。候选 `reply-comparison.ts:128` 读取全部已核 attempt，缺失／混合模式不猜；`:163` 拒绝非流式首 token，未补阶段或 COMMIT。
- 合同 `contract.md:13`、`:15` 要求无正文元数据及固定资格边界。候选 `reply-comparison.ts:57` 只投影固定 proof 元数据；`:347`、`:351`、`:354` 保留原阈值、两项 false 与96分母，符合迁移 `spec.md:98`。
- 正式 fixture 与 SHA `87fdbede…` 原捕获的完整两条 records 深等；三份 peer 正式文件及固定 material manifest 字节一致。6 base／11 formal／8 readonly 全部匹配，补丁内存重建也逐字吻合。

限制：仅独立静态审查和字节核验；未重跑作者测试，未执行模型、PG、App或微信。按 `reply-vendor-first-pilot/priority.md:24` 的 B2 范围接收判断；不签署 A、完整96质量、05或迁移完成。
