/** 只读会话元数据边界；DSH 0.2.1-rc.2 的 session 服务不承担渠道身份。
 * 官方 687f282 packages/core/session/src/index.ts 定义模型会话；本模块不调用模型或注册 Tool。
 */
import { BoundedWechatCliRunner, parseConfiguredWechatAccount } from './wechat-setup-probe.ts';

export interface WechatSessionCandidate {
  username: string;
  display_name: string;
  chat_type: 'private';
  last_timestamp: number | null;
}
export class WechatSessionsError extends Error {
  readonly code: string;
  constructor(code: string) { super('微信会话元数据核验失败。'); this.code = code; }
}
const fail = (code = 'cli_output_invalid'): never => { throw new WechatSessionsError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}

/** 仅在明确的列表请求或有效全部私聊授权内调用；本模块不建立授权。 */
export class WechatSessions {
  private readonly runner: BoundedWechatCliRunner;
  private closed = false;
  constructor(options: { executable: string; environment?: NodeJS.ProcessEnv }) {
    this.runner = new BoundedWechatCliRunner(options);
  }
  async sessions(options: { type_filter: 'private'; limit?: number; expected_account?: string; signal?: AbortSignal }): Promise<WechatSessionCandidate[]> {
    const limit = options.limit ?? 5000;
    if (options.type_filter !== 'private' || !Number.isInteger(limit) || limit < 1 || limit > 5000
      || options.expected_account !== undefined && !/^[A-Za-z0-9_.@-]{1,255}$/.test(options.expected_account)) return fail('cli_invalid_argument');
    const check = () => {
      if (this.closed) return fail('runtime_stopping');
      if (options.signal?.aborted) return fail('cli_cancelled');
    };
    check();
    const status = ['status', '--include-debug', '--strict-read-only'];
    const before = parseConfiguredWechatAccount(await this.runner.run(status, 5000, options.signal));
    check();
    if (options.expected_account !== undefined && before !== options.expected_account) return fail('cli_account_changed');
    const data = object(await this.runner.run(['sessions', '--type-filter', 'private', '--limit', String(limit), '--strict-read-only'], 1000, options.signal));
    check();
    // 没有分页结束证据时，达到上限意味着可能截断，不能作为完整授权快照。
    if (!Array.isArray(data.sessions) || data.sessions.length >= limit) return fail();
    const candidates: WechatSessionCandidate[] = [];
    const identities = new Set<string>();
    for (const raw of data.sessions) {
      const row = object(raw);
      if (typeof row.chat_type !== 'string' || !row.chat_type.trim()) return fail();
      if (row.chat_type !== 'private') continue;
      if (typeof row.username !== 'string' || !/^[A-Za-z0-9_.@-]{1,255}$/.test(row.username)) return fail();
      // 不从展示名补造身份，也不接受伪装为私聊的群聊和公众号定位标识。
      if (row.username.endsWith('@chatroom') || row.username.startsWith('gh_')) continue;
      if (identities.has(row.username)) return fail('cli_identity_conflict');
      identities.add(row.username);
      if (typeof row.display_name !== 'string' || row.display_name.length > 4096) return fail();
      const timestamp = row.last_timestamp ?? null;
      if (timestamp !== null && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp))) return fail();
      candidates.push({ username: row.username, display_name: row.display_name.trim() ? row.display_name : row.username,
        chat_type: 'private', last_timestamp: timestamp });
    }
    const after = parseConfiguredWechatAccount(await this.runner.run(status, 5000, options.signal));
    check();
    if (after !== before) return fail('cli_account_changed');
    return candidates;
  }
  async close(): Promise<void> { this.closed = true; await this.runner.close(); }
}
