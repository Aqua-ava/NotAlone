// 已接纳生成还需等待前台许可、模型前后复验和可靠保存，不能只按模型20秒期限截断HTTP。
// 使用现有单请求120秒上限；模型期限、30秒业务租约及用户/退出/断连取消保持原合同。
export const ASSISTANT_GENERATION_TIMEOUT_MS = 120_000;
