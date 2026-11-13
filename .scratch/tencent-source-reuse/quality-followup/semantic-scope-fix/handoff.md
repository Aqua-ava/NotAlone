# Ticket25 完整提议语义范围修复交接

- 基点：e60074b5946b8d1c990fcb75ba13bd58f789b2fb；本执行者已停止改动，未操作 index/commit。
- 范围：仅 complete-claim-verification.ts、新 semantic-scope 测试，以及获明确授权的三个现有测试现代夹具。
- A：现代 payload 补齐原提议；claim_check v2 对 12 个语义字段独立合取，不让顶层或正文 supported 覆盖未定元数据。
- B：subject_mentions 提供实际引文与候选段内的 Unicode 码点定位；sender 单独不能证明省略主体。
- 补齐：场景纳入接纳绑定；保持 UUID 规范化；复数裁切、人称冒充第三方、重复短引句均不能签归属。
- 结构：confidence/risk/来源配置不直接判假，合法 any+requires_all_sources 保留，null 与忠实未知不补事实。
- 兼容：旧 null/runtime v1 的 legacy/nullable 请求原样；显式现代策略要求嵌套 claim_check v2，旧现代 v1 响应不补签。
- 身份：已有 source_stamp 和 fingerprint 覆盖本次源码/schema/prompt/payload；旧任务、缓存不自动升级。
- 验证：56/56 相关模块；npm --prefix backend-ts run typecheck；精确文件 diff --check 通过。未运行全量。
- 保留：原两个完整命题控制、第三人称、未知日期、strict、逐项隔离、幂等、取消、来源/版本与 60/61 检查。
- 证据：manifest.json 冻结文件/SHA；exact.patch 精确 diff；evidence-shas.json 列 raw/public SHA；contract.md 说明兼容与限制。
- 日志：原始文件仓库外0700/0600；公开副本替换本机路径，包含早期 red-fields 中同类栈路径；本轮公开路径命中0。
- 数据：只用新合成材料与自有随机localhost PG测试库；未读真实库、私有诊断、既有语义评审或项目.env；真实模型调用0。
- 桌面：未启动或操作App/微信，未打包，三个既有desktop测试未动。
- 质量限制：定位和字段合取不是中文语义证明；V错误的逐项supported仍可能误判。尚不允许宣布真实质量通过。
- 下一步：根独立检查 contract.md 与 exact.patch，复核真实未定例的完整字段与指代依据后，决定是否进行已授权范围内有限真实V。
