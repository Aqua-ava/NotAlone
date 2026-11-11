import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = resolve(repository, 'desktop/src/main/reply/assistant-sessions.ts');
const partBytes = 256 * 1024;

async function loadReader(source) {
  const output = await build({
    stdin: { contents: `${source}\nexport { BackendRequestFailure };`, loader: 'ts', resolveDir: dirname(sourcePath) },
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

function fixture(bytes) {
  const inputId = randomUUID();
  const value = {
    session_id: randomUUID(), current_input_version_id: inputId, turns: [],
    inputs: [{ input_version_id: inputId, type: 'purpose_exploration', conversation_binding_id: randomUUID(),
      turn_id: null, state: 'active', placeholder: null,
      content: { type: 'purpose_exploration', correction: '', requirements: '', answer: '', confirmed_intent: '',
        skill_mode: 'auto', skill_version_id: null, purpose_hint: '合成请求计数夹具' } }],
  };
  value.inputs[0].content.answer = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(value)));
  assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
  return value;
}

function fragments(wire) {
  const buffer = Buffer.from(wire), parts = [];
  for (let start = 0; start < buffer.length;) {
    let end = Math.min(start + partBytes, buffer.length);
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
    parts.push(buffer.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts;
}

function countedBackend(reader, value, forceFallback = false) {
  const wire = JSON.stringify(value), parts = fragments(wire);
  const readId = createHash('sha256').update(wire).digest('hex');
  const calls = [];
  return {
    calls, parts,
    getConnectionGeneration: () => 7,
    requestJson: async (input) => {
      calls.push(input);
      assert.equal(input.method, 'GET');
      assert.equal(input.signal.aborted, false);
      const url = new URL(input.path, 'http://localhost');
      const number = url.searchParams.get('read_part');
      if (number === null) {
        // 旧读取先尝试默认 1 MiB 完整响应；新读取显式申请 8 MiB。
        if (Buffer.byteLength(wire) > (input.maxResponseBytes ?? 1_048_576)
          || forceFallback && input.maxResponseBytes === undefined) {
          throw new reader.BackendRequestFailure('response', undefined, 'response_too_large');
        }
        return { generation: 7, data: value };
      }
      const index = Number(number);
      assert.ok(Number.isInteger(index) && index >= 0 && index < parts.length);
      if (url.searchParams.has('read_id')) assert.equal(url.searchParams.get('read_id'), readId);
      return { generation: 7, data: {
        session_id: value.session_id, current_input_version_id: value.current_input_version_id,
        read_id: readId, part_number: index, part_count: parts.length,
        payload_bytes: Buffer.byteLength(wire), payload_fragment: parts[index],
        next_part: index + 1 < parts.length ? index + 1 : null,
      } };
    },
  };
}

test('助手完整读取请求数对照：历史真实门禁与单片回退分开计数', async (t) => {
  const scratch = resolve(repository, '.scratch/assistant-read-proof');
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(resolve(scratch, 'request-count-'));
  try {
    // 历史源码只在任务临时目录落盘，验证结束后删除，不提交副本。
    const oldPath = resolve(temporary, 'assistant-sessions.before.ts');
    await writeFile(oldPath, execFileSync('git', ['show', '2bd5d1098^:desktop/src/main/reply/assistant-sessions.ts'], { cwd: repository }));
    const before = await loadReader(await readFile(oldPath, 'utf8'));
    const after = await loadReader(await readFile(sourcePath, 'utf8'));
    for (const scenario of [
      { name: '小会话正常读取', bytes: 1024, count: 1, forceFallback: false },
      { name: '大会话自动回退', bytes: 1_048_577, count: 7, forceFallback: false },
      { name: '小会话强制回退桩', bytes: 1024, count: 3, forceFallback: true },
    ]) {
      await t.test(scenario.name, async () => {
        const value = fixture(scenario.bytes), contactId = randomUUID();
        const oldBackend = countedBackend(before, value, scenario.forceFallback);
        const newBackend = countedBackend(after, value, scenario.forceFallback);
        const oldResult = await before.readAssistantSession(oldBackend, contactId, value.session_id, new AbortController().signal);
        const newResult = await after.readAssistantSession(newBackend, contactId, value.session_id, new AbortController().signal);
        assert.deepEqual(newResult, oldResult);
        assert.equal(oldBackend.calls.length, scenario.count);
        assert.equal(newBackend.calls.length, 1);
        if (scenario.count > 1) {
          assert.equal(oldBackend.calls.length, oldBackend.parts.length + 2);
          assert.equal(new URL(oldBackend.calls.at(-1).path, 'http://localhost').searchParams.get('read_part'), '0');
          assert.ok(new URL(oldBackend.calls.at(-1).path, 'http://localhost').searchParams.has('read_id'));
        }
        t.diagnostic(`${scenario.name}: ${scenario.bytes}字节 / ${oldBackend.parts.length}片 / 旧${oldBackend.calls.length}次 / 新${newBackend.calls.length}次`);
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
