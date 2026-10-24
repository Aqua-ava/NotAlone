// 两个实际传输适配共用具名业务操作；窗口身份由各自 host 核验，不取 renderer 字段。
export type PageRole = 'manager' | 'helper';
export type PageRoleScope = PageRole | readonly PageRole[];
export interface PageCommands {
  handle(channel: string, handler: (...args: unknown[]) => unknown, role?: PageRoleScope): void;
  publish(channel: string, state: unknown, role?: PageRole): void;
}
export function pageRoleAllowed(actual: PageRole | undefined, expected?: PageRoleScope): boolean {
  if (!expected) return true;
  return actual !== undefined && (typeof expected === 'string' ? actual === expected : expected.includes(actual));
}
export function noArguments(args: unknown[]): void {
  if (args.length) throw new Error('页面操作不可用。');
}
