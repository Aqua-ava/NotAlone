// 打开已有库在写锁内完整核验；实际升级还核验升级后现场，与普通业务动作的预算分开。
export const sqliteOpenTimeoutMs = 60_000;
// 宿主与开发探针还需等待插件装配、本人身份核验和认证握手。
export const sqliteStartupTimeoutMs = sqliteOpenTimeoutMs + 15_000;

// 普通动作单次执行预算；排队等待不计入，超时即关闭 Worker 并拒绝其后的动作。
export const sqliteActionTimeoutMs = 15_000;
// 维护动作（checkpoint、VACUUM、全库校验）在 Worker 内同步执行且无法中途打断，耗时随库体积增长。
// 预算取固定下限与“按最低吞吐估算”的较大者；只用于拦住真正挂死的动作，不能让合法压缩被误杀。
export const sqliteMaintenanceMinTimeoutMs = 10 * 60_000;
export const sqliteMaintenanceMinBytesPerSecond = 4 * 1024 * 1024;
export function sqliteMaintenanceTimeoutMs(databaseBytes: number): number {
  const estimated = Number.isFinite(databaseBytes) && databaseBytes > 0 ? Math.ceil(databaseBytes / sqliteMaintenanceMinBytesPerSecond) * 1000 : 0;
  return Math.max(sqliteMaintenanceMinTimeoutMs, estimated);
}
