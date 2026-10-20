import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { candidateVersionProtocol } from './assistant-candidate-version-protocol.mjs';

const compiledInputs = [];
const compiled = await build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { readContactDirectory } from './src/main/contacts/directory';
  export { readConnection } from './src/main/backend/connection';
  export { withRewriteFixture } from './tests/rewrite-backend-fixture';
  export { withLayeredReplyFixture } from './tests/layered-reply-fixture';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { coordinateOwnerContextChanges } from './src/main/reply/owner-context-changes';
  export { installMemoryBridge } from './src/main/memory/bridge';
  export { createMemoryBridge } from './src/preload/memory';
  export { createReplyBridge } from './src/preload/reply';
  export { ExpressionPreferenceController } from './src/main/expression-preferences/controller';
  export { expressionPreferenceDeletion } from './src/main/expression-preferences/deletion';
  export { CandidateProvenanceController } from './src/main/candidate-provenance/controller';
  export { TraceController } from './src/main/traces/controller';
  export { BackendRequestFailure, JsonClient } from './src/main/backend/json-client';
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { ReplyEvidence } from './src/renderer/ReplyEvidence';
  export { ReplyCandidates } from './src/renderer/RewritePanel';
  export { readReplyEvidence } from './src/main/reply/evidence-read';
  export { renderToStaticMarkup } from 'react-dom/server';
  export { createElement } from 'react';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  jsx: 'automatic', loader: { '.css': 'empty' }, write: false,
  plugins: [{ name: 'actual-reply-evidence-inputs', setup(builder) {
    builder.onLoad({ filter: /\.(?:ts|tsx|mjs)$/ }, async (input) => {
      const contents = await readFile(input.path);
      compiledInputs.push({ path: input.path, bytes: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex') });
      return { contents, loader: input.path.endsWith('.tsx') ? 'tsx' : input.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  } }] });
if (process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF) {
  await writeFile(path.join(process.env.NOTALONE_REPLY_EVIDENCE_TEST_PROOF, `production-build-${process.pid}.json`),
    `${JSON.stringify({ cwd: process.cwd(), inputs: compiledInputs.sort((a, b) => a.path.localeCompare(b.path)),
      outputSha256: createHash('sha256').update(compiled.outputFiles[0].contents).digest('hex') }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' });
}
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), compiledModule, compiledModule.exports,
);
export const ports = compiledModule.exports;

// 合成传输边界复用生产 Main／preload 控制器；真实 HTTP／PG 在独立用例验证。
export async function historicalReplyFixture({ replyRequestId } = {}) {
  const contactId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID(), inputVersionId = randomUUID();
  const candidateId = randomUUID(), requestId = replyRequestId ?? randomUUID(), messageId = randomUUID(), memoryId = randomUUID();
  const bindingId = randomUUID();
  const candidate = { candidate_id: candidateId, text: '合成旧候选：先确认见面时间。',
    basis: '当时参考了合成关系资料。', citation_ids: [memoryId], risk_notes: [],
    messages: [{ message_id: messageId, text: '合成旧候选：先确认见面时间。' }] };
  const turn = { turn_id: turnId, input_version_id: inputVersionId, request_key: randomUUID(),
    state: 'completed', interruption_reason: null, placeholder: null,
    input: { content: { type: 'rewrite_draft', draft_text: '合成当前草稿。' } },
    reply: { reply_request_id: requestId, candidates: [candidate], context_receipt: { evidence_ids: [memoryId] } } };
  const input = { input_version_id: inputVersionId, type: 'generation', conversation_binding_id: bindingId,
    turn_id: turnId, state: 'active', content: null, placeholder: null };
  const records = { generation: 7, directory: [{ contactId, displayName: '合成依据联系人', messageCount: 1, sourceCount: 1 }],
    selection: null, saved: { session_id: sessionId,
    current_input_version_id: inputVersionId, turns: [turn], inputs: [input] },
    history: { session_id: sessionId, turn_id: turnId, candidate_id: candidateId,
      candidate_group_id: requestId, candidate_number: 1, default_display_version_id: candidateId,
      selected_version_id: null, versions: [{ version_id: candidateId, version_number: 0,
        parent_version_id: null, text: candidate.text, messages: candidate.messages, requirements: null,
        created_at: '2026-10-14T01:00:00+00:00' }] },
    evidence: { reply_request_id: requestId, evidence: [{ evidence_id: memoryId, kind: 'confirmed_memory',
      text: '合成当时资料：周末有空。', selection_reason: '与本次合成安排相关。', snapshot_status: 'active',
      cited: true, valid_at: null, invalid_at: null, timing: { recorded_at: null, source_started_at: null,
        source_ended_at: null, source_time_complete: false } }] } };
  const calls = [], handlers = new Map(), listeners = new Map(), backendListeners = new Set();
  let continuation;
  const backend = { getConnectionGeneration: () => records.generation,
    onStateChanged: (listener) => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: (observer) => observer.connected(),
    requestJson: async (request) => {
      calls.push(request);
      if (request.path.startsWith('/api/contacts/') && !request.path.startsWith(`/api/contacts/${contactId}/`)) {
        throw new ports.BackendRequestFailure('response', 404);
      }
      const failure = records.failure?.(request);
      if (failure) { await records.beforeFailure?.(request); throw failure; }
      const generated = records.saved.turns.at(-1);
      if (request.path.endsWith('/replies/prepare')) generated.request_key = request.body.idempotency_key;
      if (request.path.endsWith('/continue/prepare')) continuation = { turnId: randomUUID(),
        inputVersionId: randomUUID(), replyRequestId: randomUUID(), candidateId: randomUUID(), messageId: randomUUID(),
        requestKey: request.body.idempotency_key };
      if (request.path.endsWith('/continue') && continuation) {
        const next = continuation;
        const text = '合成当前依据的新候选。';
        const input = { content: { type: 'rewrite_draft', draft_text: request.body.intention_update ?? '合成当前草稿。',
          include_relationship_context: false, user_instruction: request.body.instruction } };
        const reply = { reply_request_id: next.replyRequestId, candidates: [{ candidate_id: next.candidateId,
          text, basis: '重新核验当前合成依据。', citation_ids: [], risk_notes: [],
          messages: [{ message_id: next.messageId, text }] }], context_receipt: { evidence_ids: [] } };
        records.saved.turns.push({ turn_id: next.turnId, input_version_id: next.inputVersionId, request_key: next.requestKey,
          state: 'completed', interruption_reason: null, input, reply, placeholder: null, basis_changes: [] });
        records.saved.inputs.push({ input_version_id: next.inputVersionId, type: 'generation', conversation_binding_id: bindingId,
          turn_id: next.turnId, state: 'active', content: null, placeholder: null });
        records.saved.current_input_version_id = next.inputVersionId;
        const response = { ...reply, session_id: sessionId, turn_id: next.turnId, input_version_id: next.inputVersionId, state: 'completed',
          effective_input: input.content, continuation: { candidate_group_id: request.body.displayed_group.candidate_group_id,
            candidate_id: null, version_id: null, effective_requirements: [request.body.instruction],
            effective_intent: { source: 'draft_text' } } };
        await records.beforeResponse?.(request);
        return { generation: records.generation, data: response };
      }
      const data = request.path.endsWith('/assistant-session/default') ? { session_id: records.saved.session_id }
        : request.path.endsWith('/continue/prepare') ? { session_id: sessionId, turn_id: continuation.turnId,
          input_version_id: continuation.inputVersionId, request_key: continuation.requestKey, state: 'running' }
        : request.path.endsWith('/versions') ? records.history
          : request.path.endsWith('/selections') ? { selection: records.selection }
            : request.path.endsWith('/evidence') ? records.evidence
              : request.path.endsWith('/replies/prepare') ? { session_id: sessionId, turn_id: generated.turn_id,
                request_key: generated.request_key, input_version_id: generated.input_version_id, state: generated.state }
                : request.path.endsWith('/replies') ? { ...generated.reply, session_id: sessionId,
                  turn_id: generated.turn_id, input_version_id: generated.input_version_id, state: 'completed' }
                  : records.saved;
      const response = structuredClone(data);
      await records.beforeResponse?.(request);
      return { generation: records.generation, data: response };
    } };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation,
    contacts: records.directory }));
  contacts.setConnection(7); await contacts.refreshContacts();
  const commands = { handle: (channel, handler) => { assert(!handlers.has(channel)); handlers.set(channel, handler); },
    publish: (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); } };
  const replies = ports.installReplyBridge(commands, candidateVersionProtocol(backend), contacts);
  const transport = { invoke: async (channel, ...args) => handlers.get(channel)(...args),
    on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) };
  const bridge = ports.createReplyBridge(transport);
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = { contactId, scopeRevision: contacts.getState().scopeRevision };
  return { bridge, replies, contacts, commands, transport, records, calls, backend, backendListeners, scope, sessionId, turnId, inputVersionId,
    candidateId, requestId, messageId, memoryId, bindingId };
}

export function renderSession(state) {
  return ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state } }));
}
