import {createSyntheticProfile} from './profile-support.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const cleanupGroups = new WeakMap();
function registerCleanup(t, cleanup) {
  let group = cleanupGroups.get(t);
  if (!group) {
    group = [];
    cleanupGroups.set(t, group);
    t.after(async () => {
      const results = await Promise.allSettled(group.map(dispose => dispose()));
      const failures = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (failures.length) throw new AggregateError(failures, '测试宿主清理或边界检查失败');
    });
  }
  group.push(cleanup);
}

export function sendEvents(res, events) {
  res.setHeader('content-type', 'text/event-stream');
  res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
}

export function useTool(events, name, args = {}, id = 'synthetic-call') {
  events.splice(1, 3,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 });
  events[4].delta.stop_reason = 'tool_use';
}

export async function startReplyServiceHost(t, database, reply, {pluginPath = 'test/reply-service-runtime-plugin.ts', environment = {}} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'notalone-dsh-validation-'));
  const requests = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
    const events = [
      { type: 'message_start', message: { id: 'synthetic', model: 'deepseek-v4-flash', usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify({ text: '合成候选', evidence: 'source-a1' }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    if (reply) return reply(req, res, requests, events);
    sendEvents(res, events);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerPort = provider.address().port;
  const profileDir = join(home, 'profiles', 'notalone'); await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  let patch = await createSyntheticProfile(resolve(pluginPath), `http://127.0.0.1:${provider.address().port}/anthropic`);
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch);
  const child = spawn(process.execPath, ['--import', resolve('test/observe.mjs'), resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'notalone'], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'synthetic-only', NOTALONE_SYNTHETIC_PROVIDER_URL: `http://127.0.0.1:${provider.address().port}/anthropic`, NOTALONE_SYNTHETIC_DATABASE: database.name, NOTALONE_SYNTHETIC_DATABASE_USER: database.user, ...(database.replyOwner?{NOTALONE_SYNTHETIC_REPLY_OWNER:database.replyOwner}:{}), ...(database.replyToken?{NOTALONE_SYNTHETIC_REPLY_TOKEN:database.replyToken}:{}), ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', b => { output += b; });
  const exited = once(child, 'exit');
  registerCleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    await rm(home, { recursive: true, force: true });
    await database.close();
    await assert.rejects(readFile(join(home, '.anonymous-user-id')), { code: 'ENOENT' });
    for (const request of requests) {
      assert.equal(request.path, '/anthropic/v1/messages');
      assert.doesNotMatch(JSON.stringify(request), /dsh_session_log|dsh_plugin_packages/);
    }
    const connections = output.split('\n').filter(l => l.startsWith('VALIDATION_NETWORK ')).map(l => JSON.parse(l.slice(19)));
    assert.ok(connections.every(c => (c.host === '127.0.0.1' && Number(c.port) === providerPort)
      || c.path === '/tmp/.s.PGSQL.5432' || c.port === '/tmp/.s.PGSQL.5432'
      || environment.NOTALONE_SYNTHETIC_L2 === '1' && c.path === join(home, 'l2-permit.sock')), JSON.stringify(connections));
  });
  const url = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动超时 ${output}`)), 15000);
    child.stdout.on('data', b => { output += b; const m = output.match(/VALIDATION_READY (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); resolveReady(m[1]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`启动退出 ${output}`)); });
  });
  return { child, requests, home, url, get output() { return output; },
    async stop(signal = 'SIGTERM') { child.kill(signal); return await exited; },
    async files() { const paths = await readdir(home, { recursive: true, withFileTypes: true }); const files = {}; for (const p of paths) if (p.isFile()) files[join(p.parentPath, p.name).slice(home.length + 1)] = await readFile(join(p.parentPath, p.name), 'utf8'); return files; }, async request(path, body) { const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); const value = await r.json(); if (!r.ok) throw new Error(JSON.stringify(value)); return value; } };
}
