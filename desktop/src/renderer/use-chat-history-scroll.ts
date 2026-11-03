import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// 用消息身份保持阅读位置；图片异步展开也沿用同一锚点。
export function useChatHistoryScroll(scope: string, revision: number, phase: string, hasMessages: boolean) {
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const position = useRef({ scope, initialized: false, follow: true, older: false, top: 0,
    anchor: null as { id: string; offset: number } | null });
  const [away, setAway] = useState(false);
  const remember = useCallback(() => {
    const element = body.current;
    if (!element || position.current.scope !== scope) return;
    const top = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find(message => message.getBoundingClientRect().bottom > top);
    position.current.anchor = anchor ? { id: anchor.dataset.messageId!, offset: anchor.getBoundingClientRect().top - top } : null;
    position.current.follow = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    position.current.top = element.scrollTop;
    setAway(!position.current.follow);
  }, [scope]);
  const restore = useCallback(() => {
    const element = body.current, saved = position.current;
    if (!element || saved.scope !== scope) return;
    if (saved.follow && !saved.older) element.scrollTop = element.scrollHeight;
    else if (saved.anchor) {
      const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(message => message.dataset.messageId === saved.anchor!.id);
      if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.anchor.offset;
    }
    remember();
  }, [scope, remember]);
  useLayoutEffect(() => {
    if (position.current.scope !== scope) {
      position.current = { scope, initialized: false, follow: true, older: false, top: 0, anchor: null };
      setAway(false);
      if (body.current) body.current.scrollTop = 0;
    }
    if (hasMessages) {
      if (!position.current.initialized) {
        position.current.initialized = true;
        position.current.follow = true;
        // 管理页本身也可滚动，首次进入时确保最新消息所在的区域进入窗口。
        body.current?.scrollIntoView({ block: 'nearest' });
      }
      restore();
    }
    if (phase !== 'loading') position.current.older = false;
  }, [scope, revision, phase, hasMessages, restore]);
  useLayoutEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(restore);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [scope, restore, hasMessages]);
  function prepareLoad(older: boolean) {
    remember();
    position.current.older = older;
    if (!older) position.current.follow = true;
  }
  function scrollToLatest() {
    position.current.follow = true;
    position.current.older = false;
    restore();
  }
  function onScroll() {
    // 程序定位的延迟 scroll 事件不重新采样，以免抢在图片尺寸更新前覆盖锚点。
    if (body.current?.scrollTop !== position.current.top) remember();
  }
  return { body, content, onScroll, prepareLoad, away, scrollToLatest };
}
