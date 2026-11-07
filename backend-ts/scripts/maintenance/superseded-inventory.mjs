#!/usr/bin/env node
/**
 * 被取代绑定副本清单（只读离线统计，不删除任何东西；ADR-175）。
 *
 * 按联系人统计：被取代绑定数、可清与保留的消息条数（及各类引用各保留多少）、可清来源记录数、
 * 可擦除的媒体托管文件数与字节。判定与 App 修复完成后的自动清理使用同一份代码（superseded.ts），
 * 所以清单数字就是真正执行时会清理的对象。
 *
 * 安全边界：
 *  - 数据库以只读方式打开（SQLITE_OPEN_READONLY），整个统计在一个读事务内，运行中的 App 不受影响；
 *    不创建 WAL/SHM，不打开存储层（不推进实例代次），不读取聊天正文。
 *  - 输出只有匿名编号与数量：不含联系人姓名、昵称、聊天内容。联系人 ID 只会写入 --mapping-out 指定的
 *    仓库外私有文件，用于确认清单时对应到具体联系人。
 *
 * 用法（在 backend-ts/）：
 *   node scripts/maintenance/superseded-inventory.mjs --db=<绝对路径到 notalone.sqlite 或其副本> \
 *     [--json-out=<绝对路径>] [--markdown-out=<绝对路径>] [--mapping-out=<绝对路径，仓库外>]
 */
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {
  retentionBreakdown, supersededBindings, supersededCounts, supersededGate,
} from '../../src/history/sqlite/superseded.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || 'true'];
}));
const fail = message => { console.error(`拒绝：${message}`); process.exit(2); };
const dbPath = args.get('db');
if (!dbPath || !dbPath.startsWith('/')) fail('--db 必须是绝对路径');
for (const key of ['json-out', 'markdown-out', 'mapping-out']) {
  const value = args.get(key);
  if (value && !value.startsWith('/')) fail(`--${key} 必须是绝对路径`);
}
// 映射文件含联系人 ID，不能落在仓库目录内。
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
if (args.get('mapping-out') && args.get('mapping-out').startsWith(repositoryRoot)) fail('--mapping-out 含联系人 ID，必须写到仓库外的私有位置');

const db = new DatabaseSync(dbPath, {readOnly: true});
db.exec('PRAGMA query_only=ON');
db.exec('BEGIN');
const reader = {
  all: (sql, values = []) => db.prepare(sql).all(...values),
  get: (sql, values = []) => db.prepare(sql).get(...values),
};
const owners = reader.all('SELECT owner_id FROM owner');
if (owners.length !== 1) fail('库内 owner 数量不是 1');
const ownerId = String(owners[0].owner_id);
const contacts = reader.all("SELECT id FROM contact WHERE owner_id=? AND state='active' ORDER BY id", [ownerId]).map(row => String(row.id));

const rows = [];
for (const contactId of contacts) {
  const bindings = supersededBindings(reader, ownerId, contactId);
  if (!bindings.length) continue;
  const bindingIds = bindings.map(b => b.bindingId);
  const counts = supersededCounts(reader, ownerId, contactId, bindings);
  const gate = supersededGate(reader, ownerId, contactId, bindings) ?? 'ready';
  const messageTotal = Number(reader.get('SELECT count(*) n FROM message WHERE owner_id=? AND contact_id=?', [ownerId, contactId]).n);
  const currentBinding = new Set(bindings.map(b => b.currentBindingId));
  const currentCopy = Number(reader.get("SELECT count(*) n FROM message WHERE owner_id=? AND contact_id=? AND availability='available' AND binding_id IN (SELECT value FROM json_each(?))",
    [ownerId, contactId, JSON.stringify([...currentBinding])]).n);
  const perBinding = bindings.map(b => Number(reader.get("SELECT count(*) n FROM message WHERE owner_id=? AND contact_id=? AND binding_id=? AND availability='available'", [ownerId, contactId, b.bindingId]).n));
  rows.push({contactId, gate, bindings: bindings.length, bindingMessages: perBinding.reduce((a, b) => a + b, 0), messageTotal,
    currentCopy, clearable: counts.clearableMessages, retained: counts.retainedMessages,
    retainedBy: retentionBreakdown(reader, ownerId, contactId, bindingIds), clearableRecords: counts.clearableRecords, emptyCaptures: counts.emptyCaptures,
    mediaFiles: counts.mediaFiles, mediaBytes: counts.mediaBytes});
}
db.exec('ROLLBACK');
db.close();

// 匿名编号按可清消息数降序、再按 ID 排序，保证重复运行编号稳定；编号与联系人 ID 的对应关系只写入仓库外的映射文件。
rows.sort((a, b) => b.clearable - a.clearable || a.contactId.localeCompare(b.contactId));
const labelled = rows.map((row, index) => ({label: `联系人${String(index + 1).padStart(2, '0')}`, ...row}));
const total = labelled.reduce((sum, row) => ({
  contacts: sum.contacts + 1, readyContacts: sum.readyContacts + (row.gate === 'ready' ? 1 : 0), bindings: sum.bindings + row.bindings,
  bindingMessages: sum.bindingMessages + row.bindingMessages, clearable: sum.clearable + row.clearable, retained: sum.retained + row.retained,
  clearableRecords: sum.clearableRecords + row.clearableRecords, emptyCaptures: sum.emptyCaptures + row.emptyCaptures,
  mediaFiles: sum.mediaFiles + row.mediaFiles, mediaBytes: sum.mediaBytes + row.mediaBytes, messageTotal: sum.messageTotal + row.messageTotal,
}), {contacts: 0, readyContacts: 0, bindings: 0, bindingMessages: 0, clearable: 0, retained: 0, clearableRecords: 0, emptyCaptures: 0, mediaFiles: 0, mediaBytes: 0, messageTotal: 0});
const gateText = {
  ready: '可清理', continuity_fence: '围栏中（修复通过后可清）', deletion_fence: '删除围栏中', recertify_running: '修复进行中',
  deletion_pending: '有未完成的删除', no_certified_current: '无已认证现行副本', current_empty: '现行副本为空', contact_inactive: '联系人不可用',
};
const mib = bytes => (bytes / 1024 / 1024).toFixed(1);
const lines = [
  '# 被取代绑定副本清单（匿名）', '',
  `统计时间点：只读快照；联系人 ${total.contacts} 位有被取代绑定，其中当前可清理 ${total.readyContacts} 位。`, '',
  '| 编号 | 状态 | 被取代绑定数 | 被取代副本消息数 | 可清消息 | 保留消息 | 可清来源记录 | 媒体文件数 | 媒体字节(MiB) | 联系人消息总数 | 现行副本消息数 |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...labelled.map(r => `| ${r.label} | ${gateText[r.gate] ?? r.gate} | ${r.bindings} | ${r.bindingMessages} | ${r.clearable} | ${r.retained} | ${r.clearableRecords} | ${r.mediaFiles} | ${mib(r.mediaBytes)} | ${r.messageTotal} | ${r.currentCopy} |`),
  `| 合计 | | ${total.bindings} | ${total.bindingMessages} | ${total.clearable} | ${total.retained} | ${total.clearableRecords} | ${total.mediaFiles} | ${mib(total.mediaBytes)} | ${total.messageTotal} | |`, '',
  '保留原因（按被引用的类别；同一条消息可被多类引用）：', '',
  ...labelled.filter(r => Object.keys(r.retainedBy).length).map(r => `- ${r.label}：${Object.entries(r.retainedBy).map(([table, n]) => `${table} ${n}`).join('，')}`), '',
  '说明：围栏中的联系人当前不会被清理；其现行副本在下一次修复通过后也会成为被取代副本，届时可清数量会相应增加（约等于“现行副本消息数”）。',
];
const summary = {generatedFor: 'superseded-history-inventory-v1', total, contacts: labelled.map(({contactId, ...row}) => row)};
if (args.get('json-out')) writeFileSync(args.get('json-out'), `${JSON.stringify(summary, null, 2)}\n`);
if (args.get('markdown-out')) writeFileSync(args.get('markdown-out'), `${lines.join('\n')}\n`);
if (args.get('mapping-out')) writeFileSync(args.get('mapping-out'), `${labelled.map(r => `${r.label}\t${r.contactId}`).join('\n')}\n`, {mode: 0o600});
console.log(lines.join('\n'));
