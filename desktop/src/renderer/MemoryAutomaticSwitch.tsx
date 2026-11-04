import { useCallback, useEffect, useRef, useState } from 'react';
import type { FixedMemoryProcessingBridge } from '../shared/fixed-memory-processing';

export interface AutomaticProcessingState {
  /** null 表示尚未读到或暂不可用，调用方不得据此推断开启或关闭。 */
  enabled: boolean | null;
  pending: boolean;
  error: string;
  set(enabled: boolean): Promise<void>;
}

/** 总开关的唯一读取点；后端库内值为准，连接或范围失效后重新核对。 */
export function useAutomaticProcessing(bridge: FixedMemoryProcessingBridge): AutomaticProcessingState {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef<number | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const read = useCallback(async () => {
    try {
      const next = await bridge.readAutomatic();
      if (!alive.current) return;
      generation.current = next.connectionGeneration; setEnabled(next.enabled); setError('');
    } catch {
      if (!alive.current) return;
      generation.current = null; setEnabled(null); setError('自动处理状态暂不可用，正在重试。');
    }
  }, [bridge]);
  useEffect(() => {
    alive.current = true; void read();
    const unsubscribe = bridge.onInvalidated(() => { void read(); });
    const timer = setInterval(() => { if (!document.hidden && !busy.current) void read(); }, 15000);
    return () => { alive.current = false; unsubscribe(); clearInterval(timer); };
  }, [bridge, read]);
  const set = useCallback(async (next: boolean) => {
    if (busy.current || generation.current === null) return;
    busy.current = true; setPending(true); setError('');
    try {
      const result = await bridge.setAutomatic({ enabled: next, connectionGeneration: generation.current });
      if (alive.current) { generation.current = result.connectionGeneration; setEnabled(result.enabled); }
    } catch {
      // 先以后端权威值覆盖本地状态，再提示；读取成功会清除旧提示，因此提示放在其后。
      await read();
      if (alive.current) setError('操作结果暂未确认，已重新读取最新状态。');
    } finally {
      busy.current = false; if (alive.current) setPending(false);
    }
  }, [bridge, read]);
  return { enabled, pending, error, set };
}

/** 记忆自动处理总开关：默认关闭，开启后才会在后台提取记忆并向模型服务发送聊天内容。 */
export function MemoryAutomaticSwitch({ bridge }: { bridge: FixedMemoryProcessingBridge }) {
  const { enabled, pending, error, set } = useAutomaticProcessing(bridge);
  const known = enabled !== null;
  return <section className="memory-processing-card memory-automatic-switch" aria-label="记忆自动处理开关">
    <header className="memory-processing-bar">
      <h2>记忆自动处理</h2>
      <button className="button" type="button" role="switch" aria-checked={enabled === true}
        disabled={!known || pending} onClick={() => void set(!enabled)}>
        {pending ? '正在保存…' : !known ? '读取中…' : enabled ? '关闭自动处理' : '开启自动处理'}
      </button>
    </header>
    {known && enabled && <p className="memory-section-note">已开启：已导入的历史和新增消息会自动提取记忆，提取时会把对应的聊天文字（和图片）发送给已配置的模型服务。关闭后，正在处理的一小批会完成再停下，之后不再发起新的调用。</p>}
    {known && !enabled && <p className="memory-section-note">已关闭：App 不会自动提取记忆，也不会为此调用模型。已有记忆仍可查看，并用于回复；新消息照常保存，开启后再统一处理。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
