import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteSkillLibrary} from '../src/skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';
import {romanceBundleRoot, validateRomanceBundle} from '../../scripts/validate_romance_reply_skills.mjs';

test('92 个恋爱包通过真实校验器，完整目录只加载一个正文及其案例', {timeout:60000}, async t => {
  const {catalog, summary} = await validateRomanceBundle();
  assert.equal(summary.packages, 92);
  assert.ok(summary.cases >= 184);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'notalone-romance-bundle-')));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const root = join(directory, 'packages'); await mkdir(root);
  for (const entry of catalog.entries) await cp(join(romanceBundleRoot, entry.name), join(root, entry.name), {recursive:true});
  const storage = await SqliteStorage.open({userData:directory, intent:'create', role:'test', registryModule:new URL('./fixtures/sqlite-skills/registry.mjs', import.meta.url).href});
  t.after(() => storage.close());
  await storage.execute('fixture.owner', {ownerId:'romance-fixture-owner'});
  const library = new SqliteSkillLibrary(storage, 'romance-fixture-owner', root);
  const discovered = await library.refresh();
  assert.equal(discovered.length, 92);
  assert.ok(discovered.every(item => item.enabledState === 'unknown' && item.currentRevisionNo === null));
  // 启用只发生在本测试的临时账号；真实库的启停选择不受测试影响。
  for (const item of discovered) await library.setEnabled(item.id, item.headRevision, 'enabled');
  const ctx = new Context(); await ctx.plugin(SkillRegistry);
  t.after(() => ctx.fiber.dispose());
  const scenarios = [7, 28, 62, 87];
  for (const id of scenarios) {
    const entry = catalog.entries.find(item => item.id === id);
    const key = {}, layer = createScope(ctx, key);
    const scope = {ownerId:'romance-fixture-owner', contactId:'romance-fixture-contact', callId:`scenario-${id}`};
    await storage.execute('fixture.scope', scope);
    const run = await openSqliteSkillRun(library, scope, {
      assertCurrent:(current, revision, signal) => {signal?.throwIfAborted(); return storage.execute('fixture.checkScope', {scope:current, revision});},
      recordSelection:async (_current, _selected, signal) => {signal?.throwIfAborted();},
      recordInput:async (input, signal) => {signal?.throwIfAborted(); await storage.execute('fixture.input', input);},
    });
    try {
      run.mount(layer.ctx);
      assert.equal((await ctx.skills.list({scope:key})).length, 92);
      assert.equal((await ctx.skills.list()).length, 0);
      assert.equal(run.loaded, null);
      const definition = await ctx.skills.get(entry.name, {scope:key});
      assert.ok(definition.content.includes('references/cases.md'));
      assert.equal(run.loaded.name, entry.name);
      const text = await run.readLoadedResource('references/cases.md');
      assert.match(text, /案例|示例/);
      const other = catalog.entries.find(item => item.id !== id);
      await assert.rejects(ctx.skills.get(other.name, {scope:key}), {code:'second_skill_load'});
      const inputs = await storage.execute('fixture.inputs', scope);
      assert.deepEqual(inputs.map(item => item.relative_path), ['SKILL.md', 'references/cases.md']);
      assert.ok(inputs.every(item => item.package_id === run.loaded.anchor.packageId));
    } finally { run.close(); await layer.dispose(); }
  }
});
