import { useEffect, useState } from 'react';
import type { BackendBridge, BackendState } from '../shared/backend-bridge';

type DraftKey = 'helper-shortcut' | 'setup-base-url' | 'setup-owner-name' | 'startup-paths';
type Draft = { baseline: string; value: unknown };
// 仅在当前管理窗口内保留非秘密编辑；不写磁盘，不接收 API Key。
const drafts = new Map<DraftKey, Draft>();
const saves = new Map<DraftKey, symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const invalidate = () => { drafts.clear(); notify(); };
let observedBackend: BackendBridge | undefined;
let unsubscribeBackend: (() => void) | undefined;

function observeConnection() {
  const backend = window.notalone.backend;
  if (!backend || backend === observedBackend) return;
  if (observedBackend) { unsubscribeBackend?.(); saves.clear(); invalidate(); }
  observedBackend = backend;
  let phase: BackendState['phase'] | undefined, revision = -1;
  const receive = (state: BackendState) => {
    if (observedBackend !== backend || state.revision < revision) return;
    revision = state.revision;
    // 本地设置保存不会因后端换连接自动取消，忙碌标记必须等具名操作结算。
    if (phase !== undefined && state.phase !== phase) invalidate();
    phase = state.phase;
  };
  // 与内存草稿同寿命，切离设置页后仍接收连接变化；窗口关闭时一并释放。
  unsubscribeBackend = backend.onStateChanged(receive);
  void backend.getState().then(receive).catch(() => {});
}

export function useSettingsDraft<T>(key: DraftKey, baseline: T | undefined) {
  const [, render] = useState(0);
  const identity = JSON.stringify(baseline);
  const draft = drafts.get(key);
  const value = baseline !== undefined && draft?.baseline === identity ? draft.value as T : baseline;
  useEffect(() => {
    observeConnection();
    const receive = () => render(revision => revision + 1);
    listeners.add(receive);
    return () => { listeners.delete(receive); };
  }, []);
  useEffect(() => {
    // 新的已保存配置优先；切页后的首帧尚未读取基准时不能误删草稿。
    if (baseline !== undefined && drafts.has(key) && drafts.get(key)!.baseline !== identity) {
      drafts.delete(key); notify();
    }
  }, [key, identity]);
  function setValue(next: T) {
    if (identity === undefined || saves.has(key)) return;
    drafts.set(key, { baseline: identity, value: structuredClone(next) }); notify();
  }
  // 保存可能在切页后才返回，只清除本次提交捕获的草稿，不覆盖后来的编辑。
  function discard() { if (drafts.get(key) === draft && drafts.delete(key)) notify(); }
  async function save<R>(operation: () => Promise<R>): Promise<R> {
    if (saves.has(key)) throw new Error('这项设置正在保存，请稍候。');
    const token = Symbol();
    // 只保存忙碌标记；请求参数（尤其 API Key）不进入跨切页存储。
    saves.set(key, token); notify();
    // 配置保存本身可能正常重启连接；业务结果沿用具名桥接，不将连接变化冒充保存失败。
    try { return await operation(); }
    finally { if (saves.get(key) === token) { saves.delete(key); notify(); } }
  }
  return [value, setValue, discard, saves.has(key), save] as const;
}
