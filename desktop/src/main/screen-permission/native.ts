import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// 路径仅由可信宿主解析当前签名包；权限过程不继承数据库或模型凭据。
export async function inspectScreenPermission(executable: string | undefined, request: boolean, signal: AbortSignal): Promise<boolean | undefined> {
  if (!executable || signal.aborted) return;
  const args = ['--screen-capture-permission', '--json'];
  if (request) args.push('--request');
  try {
    const { stdout, stderr } = await execute(executable, args, { signal, timeout: request ? 30_000 : 8000,
      maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    if (signal.aborted || stderr.trim()) return;
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    const value = result as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || value.ok !== true || typeof value.granted !== 'boolean') return;
    return value.granted;
  } catch { return; }
}
