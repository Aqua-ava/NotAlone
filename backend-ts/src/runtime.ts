import type { Context } from '@deepseek-ai/cordis';
import { validateCandidate, verifyScope, type Scope } from './business.ts';

export async function semantic(ctx: Context, input: Scope & { text: string }, signal: AbortSignal) {
  const source = verifyScope(input);
  let text = ''; let finished = false;
  for await (const chunk of ctx.llm.stream({
    provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 256, signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${source}\n${input.text}` }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish') {
      signal.throwIfAborted();
      if (chunk.reason.kind !== 'stop') throw new Error('MODEL_FAILED');
      finished = true;
    }
  }
  if (!finished) throw new Error('MODEL_INCOMPLETE');
  signal.throwIfAborted();
  return validateCandidate(text, source);
}

export async function loop(ctx: Context, input: Scope & { text: string }, signal: AbortSignal) {
  const source = verifyScope(input);
  const { defineTool } = await import('@deepseek-ai/dsh-tools');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  let text = ''; let reason = ''; let attempts = 0; let exceeded = false;
  const handle = await ctx.agents.create({
    sessionId: SessionId(crypto.randomUUID()), signal,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 256 },
    setup(scope) {
      scope.tools.guard(exec => exec.name === 'lookup_source' && Object.keys(exec.arguments as object).length > 0 ? 'UNEXPECTED_ARGUMENTS' : undefined);
      scope.tools.register(defineTool({
        name: 'lookup_source', description: '只读当前已确认合成范围的来源。', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return verifyScope(input); },
      }));
      scope.on('agent/pre-step', async (_payload, next) => {
        if (++attempts > 3) { exceeded = true; return { kind: 'reject' }; }
        return next();
      });
      scope.on('agent/assistant-stream', ({ frame }) => {
        if (frame.type === 'start') { text = ''; reason = ''; }
        if (frame.type === 'chunk') {
          if (frame.chunk.type === 'text-delta') text += frame.chunk.text;
          if (frame.chunk.type === 'finish') reason = frame.chunk.reason.kind;
        }
      });
    },
  });
  const abort = () => handle.agent.cancel({ kind: 'disposed' });
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `${source}\n${input.text}` }] }));
    await handle.agent.whenIdle();
    signal.throwIfAborted();
    if (exceeded || reason !== 'stop') throw new Error('LOOP_FAILED');
    return validateCandidate(text, source);
  } finally { signal.removeEventListener('abort', abort); await handle.dispose(); }
}
