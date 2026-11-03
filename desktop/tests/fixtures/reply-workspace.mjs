import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { candidateVersionProtocol } from './assistant-candidate-version-protocol.mjs';

const portsPromise = build({ stdin: { contents: `
  export { ContactSession } from './src/main/contacts/session';
  export { installReplyBridge } from './src/main/reply/bridge';
  export { createReplyBridge } from './src/preload/reply';
  export { BackendRequestFailure } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false })
  .then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

export async function replyWorkspaceFixture() {
  const ports = await portsPromise;
  const contactId = randomUUID(), otherContactId = randomUUID(), sessionId = randomUUID(), bindingId = randomUUID();
  const records = { generation: 1, calls: [], entries: [], discussions: [], executionBarrier: null, executionEntered: null, failExecution: false };
  const backendListeners = new Set(), handlers = new Map();
  const receipt = entry => ({ session_id: sessionId, turn_id: entry.turnId, request_key: entry.key,
    input_version_id: entry.inputId, state: entry.completed ? 'completed' : 'running' });
  const backend = {
    getConnectionGeneration: () => records.generation,
    onStateChanged: listener => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    subscribeMessages: observer => observer.connected(),
    requestJson: async request => {
      records.calls.push(request);
      const generation = records.generation;
      if (request.path.startsWith('/api/deletions?')) return { generation, data: { operations: [] } };
      if (request.path.endsWith('/assistant-session/default')) return { generation, data: { session_id: sessionId } };
      if (request.path.endsWith('/assistant-sessions')) return { generation, data: { sessions: [{ session_id: sessionId, is_current: true }], current_session_id: sessionId } };
      if (request.path.endsWith('/selections')) return { generation, data: { selection: null } };
      if (request.path.endsWith('/retry-interrupted/prepare')) {
        const key = request.body.request_key;
        let entry = records.entries.find(item => item.key === key);
        if (!entry) {
          const original = records.entries.find(item => item.turnId === request.body.original_turn_id);
          entry = { key, turnId: randomUUID(), inputId: randomUUID(), completed: false, input: structuredClone(original.input),
            reply: { reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '合成恢复候选',
              basis: '原场景与明确本次意图', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [], } } };
          entry.input.continuation = { recovery: { original_turn_id: request.body.original_turn_id,
            original_input_version_id: request.body.original_input_version_id } };
          records.entries.push(entry);
        }
        return { generation, data: receipt(entry) };
      }
      if (request.path.endsWith('/retry-interrupted')) {
        const entry = records.entries.find(item => item.key === (request.body.request_key ?? request.body.idempotency_key));
        entry.completed = true;
        return { generation, data: { ...receipt(entry), ...entry.reply, restored_input: entry.input } };
      }
      if (request.path.endsWith('/replies/prepare') || request.path.endsWith('/replace/prepare')) {
        const body = request.body.replacement ?? request.body;
        let entry = records.entries.find(item => item.key === body.idempotency_key);
        if (!entry) {
          entry = { key: body.idempotency_key, turnId: randomUUID(), inputId: randomUUID(), completed: false,
            input: { ...body, content: { ...body.content, ...(body.content.type === 'initiate_conversation' ? { purpose_source: 'direct_input' } : {}) },
              skill_disabled: body.skill_disabled ?? false, skill_version_id: body.skill_version_id ?? null },
            reply: { reply_request_id: randomUUID(), candidates: [{ candidate_id: randomUUID(), text: '合成当前候选',
              basis: '用户明确本次意图', citation_ids: [], risk_notes: [] }], context_receipt: { evidence_ids: [], } } };
          records.entries.push(entry);
        }
        return { generation, data: receipt(entry) };
      }
      if (request.path.endsWith('/replies') && request.method === 'POST') {
        const entry = records.entries.find(item => item.key === request.body.idempotency_key);
        if (records.executionBarrier) {
          const barrier = records.executionBarrier; records.executionBarrier = null;
          records.executionEntered?.resolve(); await barrier.promise;
        }
        if (records.failExecution) { records.failExecution = false; throw new ports.BackendRequestFailure('connection'); }
        entry.completed = true;
        return { generation, data: { ...receipt(entry), ...entry.reply } };
      }
      if (request.path.endsWith('/versions')) {
        const entry = records.entries.find(item => request.path.includes(item.reply.candidates[0].candidate_id));
        const candidate = entry.reply.candidates[0];
        return { generation, data: { session_id: sessionId, turn_id: entry.turnId, candidate_id: candidate.candidate_id,
          candidate_group_id: entry.reply.reply_request_id, candidate_number: 1, default_display_version_id: candidate.candidate_id,
          selected_version_id: null, versions: [{ version_id: candidate.candidate_id, version_number: 0, parent_version_id: null,
            text: candidate.text, messages: [{ message_id: randomUUID(), text: candidate.text }], requirements: null,
            created_at: '2026-10-15T01:00:00+00:00' }] } };
      }
      assert.equal(request.method, 'GET'); assert.equal(request.path.endsWith(sessionId), true);
      return { generation, data: { session_id: sessionId, current_input_version_id: records.discussions.at(-1)?.input_version_id ?? records.entries.at(-1)?.inputId ?? null,
        turns: records.entries.map(entry => ({ turn_id: entry.turnId, input_version_id: entry.inputId, request_key: entry.key,
          state: entry.interrupted ? 'failed' : entry.completed ? 'completed' : 'running', interruption_reason: entry.interrupted ? 'app_quit' : null, placeholder: null, input: entry.input,
          reply: entry.completed ? entry.reply : null })),
        inputs: [...records.entries.map(entry => ({ input_version_id: entry.inputId, type: 'generation', conversation_binding_id: bindingId,
          turn_id: entry.turnId, state: 'active', content: null, placeholder: null })), ...records.discussions] } };
    },
  };
  const contacts = new ports.ContactSession(async () => ({ generation: records.generation,
    contacts: [contactId, otherContactId].map(id => ({ contactId: id, displayName: '合成场景联系人', messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const replies = ports.installReplyBridge({ handle: (channel, handler) => handlers.set(channel, handler), publish: () => {} },
    candidateVersionProtocol(backend), contacts);
  const bridge = ports.createReplyBridge({ invoke: async (channel, ...args) => handlers.get(channel)(...args), on: () => {}, removeListener: () => {} });
  contacts.selectContact({ contactId, scopeRevision: contacts.getState().scopeRevision });
  const scope = () => ({ contactId: contacts.getState().selectedContactId, scopeRevision: contacts.getState().scopeRevision });
  await bridge.readSavedSession(scope());
  await bridge.setMode({ ...scope(), mode: 'initiate_conversation' });
  await bridge.updatePurpose({ ...scope(), purpose: '先核对安排，不增加承诺。' });
  return { records, bridge, replies, contacts, backendListeners, contactId, otherContactId, scope };
}

