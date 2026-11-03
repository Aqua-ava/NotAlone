import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContactChatHistory } from '../../src/renderer/ContactChatHistory';
import '../../src/renderer/contacts.css';

const contacts = [{ contactId: 'a', displayName: '合成联系人甲' }, { contactId: 'b', displayName: '合成联系人乙' }];
const noop = async () => {};
let selection = { selectedContactId: 'a', scopeRevision: 1, contacts };
const message = (index: number) => ({ messageId: `m${index}`, speaker: index % 3 ? 'contact' : 'user', messageType: 'text',
  text: `合成消息 ${index}：${index % 3 ? '明天一起去走走，顺便聊聊最近的安排。' : '好，时间确定后告诉我。'}`,
  occurredAt: new Date(Date.UTC(2026, 10, 2, 15, 58) + index * 30_000).toISOString(),
  quoted: null, mediaPlaceholder: null, ordering: 'verified', displayPosition: String(index + 20) });
let rows = Array.from({ length: 40 }, (_, index) => message(index + 1)).reverse();
let lastIndex = 40;
let history = { revision: 1, contactId: 'a', scopeRevision: 1, messages: { phase: 'ready', items: rows, nextCursor: 'older' }, error: null };
const listeners = new Set<Function>();
function publish(patch: object = {}) {
  history = { ...history, ...patch, revision: history.revision + 1 };
  listeners.forEach(listener => listener(history));
}
Object.assign(window, {
  calls: [],
  completeOlder() { rows = [...rows, ...Array.from({ length: 10 }, (_, index) => message(-index))];
    publish({ messages: { phase: 'ready', items: rows, nextCursor: null } }); },
  addMessage() { rows = [message(++lastIndex), ...rows]; publish({ messages: { ...history.messages, items: rows } }); },
  replaceRows(items: object[]) { publish({ messages: { phase: 'ready', items, nextCursor: null } }); },
  selectOther() { selection = { ...selection, selectedContactId: 'b', scopeRevision: 2 }; render(); },
  publishOther() { publish({ contactId: 'b', scopeRevision: 2, messages: { phase: 'ready', items: [{ ...message(99), text: '乙的合成消息' }], nextCursor: null } }); },
  publishOld() { publish({ messages: { phase: 'ready', items: rows, nextCursor: null } }); },
  notalone: { contactHistory: { getState: async () => history,
    onStateChanged: (listener: Function) => { listeners.add(listener); return () => listeners.delete(listener); },
    load: async (request: { older: boolean }) => {
      (window as any).calls.push(request);
      if (request.older) publish({ messages: { ...history.messages, phase: 'loading' } });
      else { lastIndex = 40; rows = Array.from({ length: 40 }, (_, index) => message(index + 1)).reverse();
        publish({ messages: { phase: 'ready', items: rows, nextCursor: 'older' } }); }
    } }, media: {} },
});
const root = createRoot(document.getElementById('root')!);
function render() { root.render(<ContactChatHistory session={{ state: selection } as any} settings={<p>合成资料设置</p>} />); }
render();
