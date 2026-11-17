import {useEffect, useMemo, useRef, useState} from 'react';
import type {MemoryDecisionRequest, MemoryDocumentsSnapshot, MemoryManagementOutcome, MemoryManagementRead, MemoryManagementSnapshot, SqliteMemoryManagementBridge} from '../shared/sqlite-memory-management';
import {useMemoryBrowserRead} from './use-memory-browser-read';
import {useVisibleRefresh} from './use-visible-refresh';
import {outcomeMessages, successMessages} from './memory-management-messages';

export type MemoryBrowserDecision = Omit<MemoryDecisionRequest, 'requestKey'>;
export type MemoryBrowserLevel = 'L1' | 'L2' | 'L3';
type DocumentAvailability = 'available' | 'checking' | 'blocked';
export interface MemoryBrowserDocuments {
  snapshot: MemoryDocumentsSnapshot | null;
  busy: boolean;
  notice: string | null;
  availability: DocumentAvailability;
}
interface Options {
  bridge: SqliteMemoryManagementBridge;
  contactId: string | null;
  scopeRevision: number;
  documentsRefreshKey?: number;
  completedRunId?: string | null;
  visible?: boolean;
  releaseOnUnmount?: boolean;
}
/** 具体记忆与发布集合独立读取；范围、决定和失效次序由浏览模块统一管理。 */
export function useMemoryBrowser({bridge, contactId, scopeRevision, documentsRefreshKey = 0, completedRunId = null, visible = true, releaseOnUnmount = true}: Options) {
  const [scopeKind, setScopeKind] = useState<'contact' | 'self'>('contact');
  const [level, setLevel] = useState<MemoryBrowserLevel>('L1');
  const scope = useMemo(() => ({
    request: contactId ? {scope: {scopeKind, contactId: scopeKind === 'self' ? null : contactId}, displayContactId: contactId, scopeRevision} satisfies MemoryManagementRead : null,
    active: false, authority: 0, cursor: undefined as string | undefined,
    decision: null as object | null, documentsFlight: null as object | null, documentsQueued: false,
    availability: 'available' as DocumentAvailability,
  }), [bridge, contactId, scopeRevision, scopeKind]);
  const latest = useRef(scope);
  latest.current = scope;
  const current = () => scope.active && latest.current === scope;
  const list = useMemoryBrowserRead<MemoryManagementSnapshot>(scope, '来源或范围暂不可用，已撤下原资料，请重新读取。');
  const documents = useMemoryBrowserRead<MemoryDocumentsSnapshot>(scope, '来源或范围暂不可用，已撤下原资料，请重新读取。');
  const [gate, setGate] = useState({scope, availability: scope.availability});
  const [decisionState, setDecisionState] = useState({scope, busy: false});
  const [pagination, setPagination] = useState({scope, previous: [] as (string | undefined)[]});
  const previousPages = pagination.scope === scope ? pagination.previous : [];
  const busy = list.busy || decisionState.scope === scope && decisionState.busy;
  const completion = useRef({last: completedRunId, version: 0, consumed: 0});
  const refresh = useRef({list: async (_preserve = false, _silent = false) => false, documents: async () => {}});

  function allowDocuments(availability: DocumentAvailability) {
    scope.availability = availability;
    if (current()) setGate({scope, availability});
  }
  function resetPage() {
    scope.cursor = undefined;
    setPagination({scope, previous: []});
  }
  function withdrawDocuments(availability: DocumentAvailability) {
    scope.documentsFlight = null;
    scope.documentsQueued = false;
    documents.clear();
    allowDocuments(availability);
  }
  refresh.current.documents = async () => {
    if (!current() || !scope.request || scopeKind !== 'contact' || typeof bridge.readDocuments !== 'function' || scope.availability !== 'available') return;
    if (scope.documentsFlight) {scope.documentsQueued = true; return;}
    const flight = {};
    scope.documentsFlight = flight;
    try {await documents.read(() => bridge.readDocuments(scope.request!), {preserve: true});}
    finally {
      if (current() && scope.documentsFlight === flight) {
        scope.documentsFlight = null;
        if (scope.documentsQueued) {scope.documentsQueued = false; queueMicrotask(() => {if (current()) void refresh.current.documents();});}
      }
    }
  };
  refresh.current.list = async (preserve = false, silent = false) => {
    if (!current() || !scope.request || scope.decision || silent && (busy || list.isReading() || list.notice?.error)) return false;
    // 只有实际开始的第一页读取才能覆盖此前的完成通知；在途静默读不能提前消费。
    if (scope.cursor === undefined) completion.current.consumed = completion.current.version;
    const authority = scope.authority;
    const outcome = await list.read(() => bridge.read({...scope.request!, ...(scope.cursor ? {cursor: scope.cursor} : {})}), {preserve, silent});
    if (!current() || authority !== scope.authority || outcome === 'stale') return false;
    if (outcome === 'invalid') withdrawDocuments('blocked');
    if (outcome === 'ready' && !scope.decision) {
      const wasBlocked = scope.availability !== 'available';
      allowDocuments('available');
      if (wasBlocked) void refresh.current.documents();
    }
    return outcome === 'ready';
  };

  useEffect(() => {
    scope.active = true;
    const unsubscribe = bridge.onInvalidated(() => {
      scope.authority++;
      scope.decision = null;
      completion.current.consumed = completion.current.version;
      list.clear({message: '资料资格或连接已变化，已撤下正文、依据和编辑，请重试读取。', error: true});
      withdrawDocuments('blocked');
      setDecisionState({scope, busy: false});
    });
    void refresh.current.list();
    void refresh.current.documents();
    return () => {scope.active = false; unsubscribe();};
  }, [scope]);
  // 桥由页面入口持有；切换浏览范围只撤下本地快照，卸载才按所有权释放。
  useEffect(() => () => {if (releaseOnUnmount) void bridge.release().catch(() => {});}, [bridge, releaseOnUnmount]);
  useEffect(() => {if (documentsRefreshKey) void refresh.current.documents();}, [documentsRefreshKey, scope]);
  useEffect(() => {
    if (completedRunId !== completion.current.last) {
      completion.current.last = completedRunId;
      if (completedRunId) completion.current.version++;
    }
    if (completion.current.consumed !== completion.current.version && !busy && !list.reading && !list.notice?.error && contactId) {
      resetPage();
      void refresh.current.list(true, true);
    }
  }, [completedRunId, busy, list.reading, list.notice, scope]);
  const wasVisible = useRef(visible);
  useEffect(() => {
    const reopened = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (reopened) void refresh.current.list(true, true);
  }, [visible]);
  const documentsVisible = visible && level !== 'L1';
  const wereDocumentsVisible = useRef(false);
  useEffect(() => {
    const reopened = documentsVisible && !wereDocumentsVisible.current;
    wereDocumentsVisible.current = documentsVisible;
    if (reopened && !documents.notice) void refresh.current.documents();
  }, [documentsVisible]);
  useVisibleRefresh(() => refresh.current.list(true, true), visible && level === 'L1' && !!contactId && !busy && !list.notice?.error, list.snapshot?.view.page?.preparing ? 1000 : 30000);
  useVisibleRefresh(() => refresh.current.documents(), documentsVisible && !documents.notice && scope.availability === 'available', 2000);

  async function decide(request: MemoryBrowserDecision) {
    const snapshot = list.snapshot;
    if (!snapshot || !scope.request || busy || scope.decision) return;
    const decision = {};
    scope.decision = decision;
    scope.authority++;
    list.clear();
    withdrawDocuments('checking');
    setDecisionState({scope, busy: true});
    let outcome: MemoryManagementOutcome;
    try {outcome = await bridge.decide({...scope.request, connectionGeneration: snapshot.connectionGeneration, request: {...request, requestKey: crypto.randomUUID()}});}
    catch {outcome = {status: 'unavailable'};}
    if (!current() || scope.decision !== decision) return;
    scope.decision = null;
    if (outcome.status !== 'applied') {
      allowDocuments('blocked');
      setDecisionState({scope, busy: false});
      list.notify({message: outcomeMessages[outcome.status], error: true});
      return;
    }
    resetPage();
    const authority = scope.authority;
    const refreshed = await refresh.current.list();
    if (!current() || authority !== scope.authority) return;
    setDecisionState({scope, busy: false});
    if (!refreshed) allowDocuments('blocked');
    list.notify({message: refreshed ? successMessages[request.action] ?? '决定已保存。' : '决定已保存，但当前资料暂不可读。已撤下原资料，请重新读取。', error: !refreshed});
  }
  function restart() {
    const preserve = !!list.snapshot && scope.cursor === undefined;
    resetPage();
    void refresh.current.list(preserve);
  }
  function changePage(cursor: string | undefined, previous: (string | undefined)[]) {
    scope.cursor = cursor;
    setPagination({scope, previous});
    void refresh.current.list();
  }
  const availability = gate.scope === scope ? gate.availability : 'available';
  const documentView: MemoryBrowserDocuments = {
    snapshot: documents.snapshot, busy: documents.busy, notice: documents.notice?.message ?? null,
    availability: availability === 'available' ? 'available' : busy ? 'checking' : 'blocked',
  };
  return {
    scopeKind, setScopeKind, level, setLevel, readRequest: scope.request,
    current: list.snapshot, notice: list.notice, busy, decide, restart,
    page: previousPages.length + 1, hasPreviousPage: previousPages.length > 0,
    previousPage: () => changePage(previousPages.at(-1), previousPages.slice(0, -1)),
    nextPage: () => {if (list.snapshot?.view.page?.nextCursor) changePage(list.snapshot.view.page.nextCursor, [...previousPages, scope.cursor]);},
    documents: documentView,
    retryDocuments: () => {if (scope.availability === 'available') void refresh.current.documents(); else void refresh.current.list();},
  };
}
