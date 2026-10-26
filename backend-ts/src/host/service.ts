import type { Context } from '@deepseek-ai/cordis';
import { semantic, loop } from './runtime.ts';
import { verifyScope, revokeScope, type Scope } from './business.ts';

export class ValidationService {
  private runs = new Map<string, { scope: Scope; controller: AbortController; done: Promise<unknown> }>();
  private ctx: Context;
  constructor(ctx: Context) { this.ctx = ctx; }
  get active() { return this.runs.size; }
  cancel(input: Scope & { run_id: string }) {
    verifyScope(input);
    const run = this.runs.get(input.run_id);
    if (!run || run.scope.owner_id !== input.owner_id || run.scope.contact_id !== input.contact_id) return { canceled: false };
    run.controller.abort(new Error('CANCELED'));
    return { canceled: true };
  }
  revoke(input: Scope) {
    verifyScope(input);
    for (const [id, run] of this.runs) {
      if (run.scope.owner_id === input.owner_id && run.scope.contact_id === input.contact_id) this.cancel({ ...input, run_id: id });
    }
    return { revoked: revokeScope(input) };
  }
  async execute(mode: string, input: Scope & { text: string; run_id?: string; deadline_ms?: number }) {
    verifyScope(input);
    if (typeof input.text !== 'string' || input.text.length > 4000) throw new Error('INPUT_LIMIT');
    const id = input.run_id ?? crypto.randomUUID();
    if (typeof id !== 'string' || this.runs.has(id)) throw new Error('RUN_CONFLICT');
    const deadline = input.deadline_ms ?? 3000;
    if (!Number.isInteger(deadline) || deadline < 20 || deadline > 10000) throw new Error('DEADLINE_INVALID');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('TIMED_OUT')), deadline);
    const done = (mode === '/loop' ? loop : semantic)(this.ctx, input, controller.signal);
    this.runs.set(id, { scope: input, controller, done });
    try { return await done; }
    finally { clearTimeout(timer); this.runs.delete(id); }
  }
  async dispose() {
    for (const run of this.runs.values()) run.controller.abort(new Error('CANCELED'));
    await Promise.allSettled([...this.runs.values()].map(run => run.done));
  }
}
