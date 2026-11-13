# 本轮输出配置更新

- 人类最新要求已在状态汇总会话核实：输出和费用本轮不作为人为限制、停止或验收门槛；主协调负责统一验收说明和后续真实执行。
- 本增量只修改 `backend-ts/src/host-reply-config.ts`、原配置测试及新 `model-output-configuration.test.mjs`，历史 complete-claim 的 31 文件和 manifest 保持原样。
- 移除宿主固定 4096 默认值；未指定输出值时使用 393216。配置键为 `NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS`，允许按任务选择正整数，校验服务端可接受上限；无静默截断或缩回 4096。
- 输出上限来自 [DeepSeek 官方模型目录](https://api-docs.deepseek.com/api/list-models/) 的 `deepseek-flash.max_output_tokens=393216`，查证日期为 2026-10-25；context_window=1048576 独立保留，不拿 context 或 SDK fallback 推测输出上限。
- 锁定 SDK `@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.2` 的 catalog `maxTokens` 同时用于默认请求额度，因此 connection、catalog 及实际 binding 均使用同一配置值。
- ordinary 官方 adapter 的最终 fetch 实体核对默认 393216 与显式 65536；strict 实际 send 入口核对 393216/65536/8192，原 beforeDispatch 每次仅执行一次，HTTP 实体 hash 与记录快照相同。
- 所有 fetch 均由合成响应拦截，真实供应商调用为 0；没有读取凭据、真实样本或业务库，没有修改实际配置文件、费用记录、模型许可、unknown 或取消处理。
- 原输入尺寸计量和 ledger/provider 源码未改。本轮小窗探针依次为 1 短、4 短、1 长 8192 码点、4 长各 8192 码点。
- 原输入代理值为 18214/20329/42696/118257；输出配置均为 393216、context 1048576、安全余量 65536；保守总量分别为 476966/479081/501448/577009，均通过原 guard。
- UTF-8 字节仍只称保守代理，actual token counts 为 null。max_tokens 表示允许生成的上限，不等于实际生成、消费或每次必须产满；未据数学极端范围认定真实 context 误拒。
- RED：原配置和 strict 请求均仍为 4096，新用例 0/2 通过；原始失败保留在 `red.log`。GREEN 与 TSC 结果见增量 manifest 及日志。
- 原费用和 4096 研究记录继续作为历史证据；本增量不把它们重新用于阻止后续质量核验。没有追加容量优化任务或真实外呼。
- Git 仍由主协调独占；本会话未操作 index/commit/push。桌面验收、独立质量判断和实际调用由主协调继续推进，开发入口保持 `npm run dev`。
