import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * 单连接的预编译语句缓存（LRU）。
 * 只在 Worker 线程内使用；语句每次 `.all()/.run()` 后自动复位，同步执行不会交叉占用。
 * 容量有限，避免动态拼接的 SQL（如不定长 IN 列表）无限占用内存；语句随连接关闭一并释放。
 */
export function statementCache(connection: DatabaseSync, limit = 256): (sql: string) => StatementSync {
  const cache = new Map<string, StatementSync>();
  return (sql: string): StatementSync => {
    const hit = cache.get(sql);
    if (hit) { cache.delete(sql); cache.set(sql, hit); return hit; }
    const statement = connection.prepare(sql);
    statement.setReadBigInts(true);
    cache.set(sql, statement);
    if (cache.size > limit) cache.delete(cache.keys().next().value as string);
    return statement;
  };
}
