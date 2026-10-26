// 合成完成观测辅助：只使用调用方提供的读写端口，不启动 App 或后台。
type SmokePollPorts = {
  read: () => Promise<{ phase: unknown; errorCode?: unknown; resultPresent: unknown }>;
  poll: (read: () => Promise<string>) => Promise<void>;
  inspect: () => Promise<Record<string, unknown>>;
  persist: (record: unknown) => Promise<void>;
  now?: () => number;
};

export async function observeReplySmokeCompletion(ports: SmokePollPorts): Promise<void> {
  const now = ports.now ?? Date.now;
  const phases = ['idle', 'waiting', 'ready', 'failed'];
  const errors = ['generation_failed', 'save_failed', 'timeout', 'unavailable', 'rejected', 'target_unavailable',
    'source_unavailable', 'connection', 'input_budget_exceeded', 'input_budget_unavailable', 'provider_context_limit'];
  const record = { samples: [] as Array<{ sampledAtMs: number; phase: string | null; errorCode: string | null;
    resultPresent: boolean | null; readFailed: boolean }>, pollState: 'waiting',
  inspection: { state: 'not-requested' } as Record<string, unknown>, persistenceFailed: false };
  const persist = async () => {
    try { await ports.persist(record); } catch { record.persistenceFailed = true; }
  };
  let failed = false;
  let original: unknown;
  try {
    await ports.poll(async () => {
      let state: Awaited<ReturnType<SmokePollPorts['read']>>;
      try { state = await ports.read(); }
      catch (error) {
        record.samples.push({ sampledAtMs: now(), phase: null, errorCode: null, resultPresent: null, readFailed: true });
        await persist();
        throw error;
      }
      const phase = typeof state.phase === 'string' && phases.includes(state.phase) ? state.phase : 'unknown';
      const errorCode = state.errorCode == null ? null
        : typeof state.errorCode === 'string' && errors.includes(state.errorCode) ? state.errorCode : 'unknown';
      const resultPresent = typeof state.resultPresent === 'boolean' ? state.resultPresent : null;
      record.samples.push({ sampledAtMs: now(), phase, errorCode, resultPresent, readFailed: false });
      await persist();
      return resultPresent === true ? 'completed' : phase === 'failed' ? 'failed' : 'pending';
    });
    record.pollState = 'settled';
  } catch (error) { failed = true; original = error; record.pollState = 'failed'; }
  // 只读本场既有控制命令；无正文快照不能替代正式完成断言。
  try {
    const value = await ports.inspect();
    const counts = typeof value.counts === 'object' && value.counts !== null ? value.counts as Record<string, unknown> : {};
    const count = (input: unknown) => Number.isSafeInteger(input) && Number(input) >= 0 ? input : null;
    const states = ['running', 'failed', 'expired', 'completed'];
    const failures = ['cancelled', 'timeout', 'transport_error', 'budget_or_contract_abort', 'response_model_mismatch', 'provider_http_error'];
    record.inspection = { state: 'ok', observedAtMs: now(),
      counts: Object.fromEntries(['message', 'source_document', 'confirmed_memory', 'memory_candidate', 'background_task', 'reply_request']
        .map(name => [name, count(counts[name])])),
      replyStates: Array.isArray(value.reply_states) ? value.reply_states.slice(0, 32)
        .map(state => typeof state === 'string' && states.includes(state) ? state : 'unknown') : null,
      truncated: Array.isArray(value.reply_states) && value.reply_states.length > 32
        || Array.isArray(value.status_codes) && value.status_codes.length > 32,
      provider: { responses: count(value.responses), responseModelMatches: typeof value.response_model_matches === 'boolean' ? value.response_model_matches : null,
        statusCodes: Array.isArray(value.status_codes) ? value.status_codes.slice(0, 32)
          .map(code => Number.isInteger(code) && code >= 100 && code <= 599 ? code : null) : null,
        failureKind: value.failure_kind == null ? null
          : typeof value.failure_kind === 'string' && failures.includes(value.failure_kind) ? value.failure_kind : 'unknown' } };
  } catch { record.inspection = { state: 'failed', observedAtMs: now() }; }
  await persist();
  if (failed) throw original;
  if (record.persistenceFailed) throw new Error('本场模型完成观测写入未确认。');
}
