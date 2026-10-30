// 已有库打开包含锁外、锁内及提交前的完整性检查；与普通业务动作的预算分开。
export const sqliteOpenTimeoutMs = 60_000;
// 宿主与开发探针还需等待插件装配、本人身份核验和认证握手。
export const sqliteStartupTimeoutMs = sqliteOpenTimeoutMs + 15_000;
