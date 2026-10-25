// 复制到夹具私有目录后运行；只处理旁边的合成状态，绝不委派真实 CLI。
import {appendFileSync, readFileSync, watch} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const state = () => JSON.parse(readFileSync(join(directory, 'control.json'), 'utf8'));
const initial = state();
appendFileSync(join(directory, 'cli-commands.jsonl'), JSON.stringify({
  at: new Date().toISOString(), pid: process.pid, args,
}) + '\n', {mode: 0o600});
const emit = data => process.stdout.write(JSON.stringify({ok: true, data}) + '\n');
const sessions = initial.contacts.map(contact => ({
  username: contact.externalId, display_name: contact.name, chat_type: 'private',
  last_timestamp: 1792893600,
}));
const contact = initial.contacts.find(item => item.externalId === args[1]);
if (args[0] === '--version' && args.length === 1) emit({version: 'synthetic-native-basic-1'});
else if (args[0] === 'status') emit({status: {
  account: {identity_configured: true, schema2_ready: true},
  account_debug: {wxid: initial.account}, live_read_ok: true,
  readiness: 'ready', mode: {strict_read_only: true},
}});
else if (args[0] === 'sessions') emit({sessions});
else if (args[0] === 'resolve-chat') emit({candidates: sessions.filter(item =>
  [item.username, item.display_name].includes(args[1]))});
else if (args[0] === 'tail' && args.includes('--follow') && args.includes('--mode')) {
  // 受控事件源由显式修改 control.json 唤醒；没有真实渠道、定时读库或发送路径。
  const announce = () => {
    const current = state();
    for (const item of current.contacts) process.stdout.write(JSON.stringify({
      type: 'session', cursor: `synthetic-session-${current.incremental}-${item.externalId}`,
      session: {username: item.externalId},
    }) + '\n');
  };
  const watcher = watch(join(directory, 'control.json'), announce);
  process.once('SIGTERM', () => {watcher.close(); process.exit(0);});
  announce();
} else if (args[0] === 'tail' && contact && args.includes('--strict-read-only')) {
  const history = args.includes('--history');
  const cursor = args.includes('--cursor') ? args[args.indexOf('--cursor') + 1] : null;
  const historyCursor = `synthetic-history-${contact.externalId}`;
  const incrementalCursor = `synthetic-incremental-${contact.externalId}`;
  const rows = history && cursor !== historyCursor ? [
    {id: 201, text: `${contact.name}：合成历史第一条。`, fromMe: false},
    {id: 202, text: '合成本人：已收到合成历史。', fromMe: true},
  ] : !history && initial.incremental && ![historyCursor, incrementalCursor].includes(cursor) ? [
    {id: 203, text: `${contact.name}：合成增量第三条。`, fromMe: false},
  ] : !history && initial.incremental && cursor === historyCursor ? [
    {id: 203, text: `${contact.name}：合成增量第三条。`, fromMe: false},
  ] : [];
  const next = rows.length ? history ? historyCursor : incrementalCursor : cursor;
  emit({events: rows.map(row => ({type: 'message', cursor: next, message: {
    id: {local_id: row.id, talker: contact.externalId}, kind: 'text', text: row.text,
    is_from_me: row.fromMe, create_time: 1792893600 + row.id,
    sender_wxid: row.fromMe ? initial.account : contact.externalId,
  }})), cursor: next, freshness: {message_source: 'live_message_db'},
  query: {chat: contact.externalId, history, has_more: false}});
} else {
  process.stdout.write(JSON.stringify({ok: false, error: {code: 'synthetic_command_denied'}}) + '\n');
  process.exitCode = 2;
}
