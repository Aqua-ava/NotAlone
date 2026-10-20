import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { expressionPreferenceModules } from '../fixtures/expression-preference-modules.mjs';

export async function withPreferenceBackend(run, { bridge = false } = {}) {
  assert.equal(process.env.CONDA_DEFAULT_ENV, 'NotAlone', '须先激活 Conda NotAlone。');
  let evidenceDirectory;
  if (process.env.NOTALONE_PREFERENCE_EVIDENCE_DIR) {
    const requested = process.env.NOTALONE_PREFERENCE_EVIDENCE_DIR;
    assert(path.isAbsolute(requested));
    evidenceDirectory = await realpath(requested);
    const metadata = await stat(evidenceDirectory), project = await realpath(path.resolve('..'));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o777, 0o700);
    assert(evidenceDirectory !== project && !evidenceDirectory.startsWith(`${project}${path.sep}`));
  }
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-preference-http-'));
  let child;
  let cleanup;
  let exited;
  let stderr = '';
  try {
    const entry = path.join(owned, 'entry.ts'), outfile = path.join(owned, 'modules.mjs');
    await writeFile(entry, ['src/main/expression-preferences/controller.ts', 'src/main/backend/json-client.ts',
      'src/main/contacts/session.ts', 'src/main/contacts/directory.ts', 'src/main/reply/session.ts',
      'src/main/candidate-copy/controller.ts', 'src/main/candidate-provenance/controller.ts',
      ...(bridge ? ['src/main/expression-preferences/bridge.ts', 'src/preload/expression-preferences.ts'] : [])]
      .map((file) => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n'));
    // 同一次实际编译提供生产源码内容并记录摘要，避免事后构建替代运行输入。
    const compiledInputs = [], production = await realpath(path.resolve('src'));
    // 单个测试模块复用真实错误类型，避免各 bundle 产生互不相认的传输异常类。
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'actual-expression-preference-http-inputs', setup(builder) {
        builder.onLoad({ filter: /\.(?:ts|tsx|mjs)$/ }, async (input) => {
          const actualPath = await realpath(input.path);
          if (!actualPath.startsWith(`${production}${path.sep}`)) return undefined;
          const contents = await readFile(actualPath);
          compiledInputs.push({ path: actualPath, bytes: contents.length,
            sha256: createHash('sha256').update(contents).digest('hex') });
          return { contents, loader: actualPath.endsWith('.tsx') ? 'tsx' : actualPath.endsWith('.ts') ? 'ts' : 'js' };
        });
      } }] });
    if (evidenceDirectory) {
      const contents = await readFile(outfile), name = `preference-http-build-${randomUUID()}.json`;
      await writeFile(path.join(evidenceDirectory, name), JSON.stringify({ cwd: process.cwd(), bridge,
        inputs: compiledInputs.sort((a, b) => a.path.localeCompare(b.path)),
        outputSha256: createHash('sha256').update(contents).digest('hex'), outputBytes: contents.length,
      }, null, 2), { mode: 0o600, flag: 'wx' });
      process.stdout.write(`build_proof=${name} inputs=${compiledInputs.length}\n`);
    }
    const api = await import(pathToFileURL(outfile).href);
    const { JsonClient } = api;
    const expected = await expressionPreferenceModules(path.resolve('..'),
      'desktop/tests/fixtures/expression-preference-backend.py');
    child = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'), [path.resolve('tests/fixtures/expression-preference-backend.py')], {
      cwd: path.resolve('../backend'), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONPATH: `${path.resolve('../backend/src')}${path.delimiter}${path.resolve('../backend')}`, NOTALONE_DISABLE_DOTENV: '1',
        PYTHON_DOTENV_DISABLED: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false',
        NOTALONE_PREFERENCE_EXPECTED_MODULES: JSON.stringify(expected),
        NOTALONE_PREFERENCE_OWNERSHIP: path.join(owned, 'database-ownership.json') },
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve) => lines.on('line', (line) => {
      const data = JSON.parse(line);
      if (data.ready) resolve(data.ready);
      if (data.cleanup) cleanup = data.cleanup;
    }));
    const info = await Promise.race([ready, exited.then(() => { throw new Error(`偏好夹具提前退出：${stderr}`); })]);
    assert.equal(info.environment_verified, true);
    assert.equal(info.critical_module_count, Object.keys(expected).length);
    const client = new JsonClient(info);
    const backend = { getConnectionGeneration: () => 1, getState: () => ({ phase: 'connected' }),
      onStateChanged: () => () => {}, subscribeMessages: () => {},
      requestJson: async (options) => ({ generation: 1, data: (await client.perform(options)).data }) };
    let selected = info.contact_ids[0], scopeRevision = 1;
    const contacts = { getState: () => ({ selectedContactId: selected, scopeRevision, directoryPhase: 'ready',
      contacts: info.contact_ids.map((contactId) => ({ contactId })) }), onStateChanged: () => () => {} };
    try {
      await run({ ...api, backend, contacts, client,
        selection: () => ({ contactId: selected, scopeRevision }),
        select: (contactId) => { selected = contactId; ++scopeRevision; }, contactIds: info.contact_ids });
    } finally { client.cancelPending(); }
  } finally {
    // 测试断言失败也先验证自有子进程、数据库收尾；不关闭未知进程。
    if (child && child.exitCode === null) child.stdin.end('stop\n');
    if (exited) {
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.deepEqual(cleanup, { instance_ok: true, class_ok: true, database_remaining: false });
      const proof = JSON.parse(await readFile(path.join(owned, 'runtime-proof.json'), 'utf8'));
      assert.equal(proof.phase, 'complete');
      assert.equal(proof.environment_verified, true);
      assert.equal(proof.database_remaining, false);
      assert.equal(proof.fixture_cleanup_completed, true);
      const ownership = JSON.parse(await readFile(path.join(owned, 'database-ownership.json'), 'utf8'));
      const beforeImport = JSON.parse(await readFile(path.join(owned, 'import-database-ownership.json'), 'utf8'));
      assert.equal(ownership.database_name, proof.database_name);
      assert.equal(beforeImport.database_name, proof.database_name);
      assert.equal(ownership.child_pid, child.pid);
      assert.equal(beforeImport.child_pid, child.pid);
      Object.assign(proof, { child_exit_code: code, cleanup, ownership, before_import_ownership: beforeImport });
      if (evidenceDirectory) {
        const name = `preference-runtime-${randomUUID()}.json`;
        await writeFile(path.join(evidenceDirectory, name), JSON.stringify(proof, null, 2), { mode: 0o600, flag: 'wx' });
        process.stdout.write(`source_proof=${name} loaded=${proof.loaded_modules.length} critical=${proof.critical_module_count}\n`);
      }
    }
    await rm(owned, { recursive: true, force: true });
  }
}
