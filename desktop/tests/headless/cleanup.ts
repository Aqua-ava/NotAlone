// 只有各自完整收尾成功才撤销记录；断言失败不会被误记为清理失败。
export const pendingCleanup = new Set<object>();
export function ownResource() { const marker = {}; pendingCleanup.add(marker); return () => pendingCleanup.delete(marker); }
