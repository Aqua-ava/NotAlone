import { useEffect, useRef } from 'react';

/** 页面可见时更新只读快照；不重叠请求，错误由调用方展示并决定是否继续。 */
export function useVisibleRefresh(refresh: () => Promise<unknown> | unknown, enabled = true, intervalMs = 5000) {
  const latest = useRef(refresh);
  latest.current = refresh;
  const pending = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    async function update() {
      if (!active || document.hidden || pending.current) return;
      pending.current = true;
      try { await latest.current(); }
      catch { /* 调用方保留失败提示，定时器不产生未处理的拒绝。 */ }
      finally { pending.current = false; }
    }
    const onVisible = () => { if (!document.hidden) void update(); };
    const timer = setInterval(onVisible, intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs]);
}
