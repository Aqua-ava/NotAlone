import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type ShortcutAcceptanceMode = 'human' | 'agent';

export function shortcutAcceptanceMode(environment: NodeJS.ProcessEnv): ShortcutAcceptanceMode | undefined {
  const human = environment.NOTALONE_NATIVE_DESKTOP_ACCEPTANCE === '1';
  const agent = environment.NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE === '1';
  if (human && agent) throw new Error('native_shortcut_mode_conflict');
  return human ? 'human' : agent ? 'agent' : undefined;
}

// 人工确认与Agent实际按键／观察使用不同字段；任何一方都不能代签另一方。
export async function readNativeShortcutReceipt(responsePath: string, requestId: string,
  mode: ShortcutAcceptanceMode): Promise<'pending' | 'confirmed' | 'rejected' | 'invalid'> {
  let file;
  try {
    file = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return 'invalid';
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) return 'invalid';
    const receipt: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!receipt || typeof receipt !== 'object' || !('requestId' in receipt) || receipt.requestId !== requestId) return 'invalid';
    if (mode === 'human') {
      if (Object.keys(receipt).length !== 2 || !('confirmed' in receipt) || typeof receipt.confirmed !== 'boolean') return 'invalid';
      return receipt.confirmed ? 'confirmed' : 'rejected';
    }
    if (Object.keys(receipt).length !== 3 || !('performed' in receipt) || typeof receipt.performed !== 'boolean'
      || !('observed' in receipt) || typeof receipt.observed !== 'boolean') return 'invalid';
    return receipt.performed && receipt.observed ? 'confirmed' : 'rejected';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'pending' : 'invalid'; }
  finally { await file?.close(); }
}
