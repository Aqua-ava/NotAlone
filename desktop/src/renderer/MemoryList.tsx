import { useEffect, useRef, useState, type ReactNode } from 'react';

const pageSize = 6;

// 只对当前分区分页，翻页不改动资料或检索范围。
export function MemoryList<T>({ items, label, children, className = 'memory-cards', list = false }: {
  items: readonly T[]; label: string; children: (item: T) => ReactNode; className?: string; list?: boolean;
}) {
  const [requestedPage, setPage] = useState(0);
  const controls = useRef<HTMLElement>(null);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const List = list ? 'ul' : 'div';
  useEffect(() => setPage((current) => Math.min(current, pages - 1)), [pages]);
  function changePage(next: number) {
    setPage(next);
    controls.current?.scrollIntoView({ block: 'nearest' });
  }
  return <div className="memory-list">
    {items.length > 0 && <nav className="memory-pagination" aria-label={`${label}分页`} ref={controls}>
      <span role="status">共 {items.length} 条 · 第 {page + 1} / {pages} 页</span>
      <div><button className="button" disabled={page === 0} onClick={() => changePage(page - 1)}>上一页</button>
        <button className="button" disabled={page === pages - 1} onClick={() => changePage(page + 1)}>下一页</button></div>
    </nav>}
    <List className={className} key={page}>{items.slice(page * pageSize, (page + 1) * pageSize).map(children)}</List>
  </div>;
}
