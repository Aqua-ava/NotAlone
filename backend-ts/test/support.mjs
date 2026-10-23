import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export async function startHost(t, reply, fixture = false) {
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
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const providerPort = provider.address().port;
  const profileDir = join(home, 'profiles', 'notalone'); await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  let patch = await readFile(new URL('../profile/cordis.patch.yml', import.meta.url), 'utf8');
  patch = patch.replace('PLUGIN_PATH', resolve('src/plugin.ts')).replace('PROVIDER_URL', `http://127.0.0.1:${provider.address().port}/anthropic`);
  if (fixture) patch += `    - id: stalled-tool
      name: '${resolve('test/stalled-tool.ts')}'
`;
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch);
  const child = spawn(process.execPath, ['--import', resolve('test/observe.mjs'), resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'notalone'], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'synthetic-only' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', b => { output += b; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    await rm(home, { recursive: true, force: true });
    await assert.rejects(readFile(join(home, '.anonymous-user-id')), { code: 'ENOENT' });
    for (const request of requests) {
      assert.equal(request.path, '/anthropic/v1/messages');
      assert.doesNotMatch(JSON.stringify(request), /dsh_session_log|dsh_plugin_packages/);
    }
    const connections = output.split('\n').filter(l => l.startsWith('VALIDATION_NETWORK ')).map(l => JSON.parse(l.slice(19)));
    assert.ok(connections.every(c => c.host === '127.0.0.1' && Number(c.port) === providerPort), JSON.stringify(connections));
  });
  const url = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动超时 ${output}`)), 15000);
    child.stdout.on('data', b => { output += b; const m = output.match(/VALIDATION_READY (http:\/\/127\.0\.0\.1:\d+)/); if (m) { clearTimeout(timer); resolveReady(m[1]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`启动退出 ${output}`)); });
  });
  return { child, requests, home, get output() { return output; },
    async stop(signal = 'SIGTERM') { child.kill(signal); return await exited; },
    async files() { const paths = await readdir(home, { recursive: true, withFileTypes: true }); const files = {}; for (const p of paths) if (p.isFile()) files[join(p.parentPath, p.name).slice(home.length + 1)] = await readFile(join(p.parentPath, p.name), 'utf8'); return files; }, async request(path, body) { const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); const value = await r.json(); if (!r.ok) throw new Error(JSON.stringify(value)); return value; } };
}
