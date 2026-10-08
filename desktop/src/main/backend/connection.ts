import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { BackendErrorCode } from '../../shared/backend-bridge';

export type BackendConnection = Readonly<{ address: string; port: number; token: string; pid: number }>;
export class BackendFailure extends Error {
  constructor(readonly code: BackendErrorCode) { super(code); }
}

export async function readConnection(infoPath: string): Promise<BackendConnection | undefined> {
  if (!path.isAbsolute(infoPath)) throw new BackendFailure('backend_handshake_invalid');
  let file;
  try { file = await open(infoPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new BackendFailure('backend_handshake_invalid');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new BackendFailure('backend_handshake_invalid');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new BackendFailure('backend_handshake_invalid');
    const fields = new Map<string, string>();
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line) continue;
      const match = /^(address|token|pid)=(.+)$/.exec(line);
      if (!match || fields.has(match[1])) throw new BackendFailure('backend_handshake_invalid');
      fields.set(match[1], match[2]);
    }
    const address = fields.get('address') ?? '';
    const token = fields.get('token') ?? '';
    const pidValue = fields.get('pid') ?? '';
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(address);
    const port = Number(match?.[1]);
    const pid = Number(pidValue);
    if (fields.size !== 3 || !match || port > 65535 || !/^[A-Za-z0-9_-]{1,256}$/.test(token)
      || !/^[1-9][0-9]{0,9}$/.test(pidValue) || pid > 2147483647) throw new BackendFailure('backend_handshake_invalid');
    return Object.freeze({ address, port, token, pid });
  } finally { await file.close(); }
}
