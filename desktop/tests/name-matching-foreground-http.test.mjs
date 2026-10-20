import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const production = await build({ stdin: { contents: [
  "export { ForegroundController } from './src/main/foreground/controller';",
  "export { ContactSession } from './src/main/contacts/session';",
  "export { readContactDirectory } from './src/main/contacts/directory';",
  "export { JsonClient } from './src/main/backend/json-client';",
  "export { readConnection } from './src/main/backend/connection';",
  "export { withVerifiedForegroundFixture } from './tests/foreground-backend-fixture';",
].join('\n'), resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-name-matching-http-'));
await writeFile(path.join(directory, 'production.mjs'), production.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

test('认证HTTP按完整名单匹配低分多漏错字，未绑定不确认且相近未授权名称构成歧义', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const contactId = fixture.data.contact_ids[0];
    const session = { username: 'wxid_synthetic_name_match', display_name: '合成测试',
      chat_type: 'private', last_timestamp: 1700000000 };
    const unbound = { ...session, username: 'wxid_synthetic_name_unbound', display_name: '未绑定会话' };
    await fixture.setCli({ sessions: [session, unbound], messages: {} });
    assert.equal((await fixture.request('/api/sync/cli-bindings/confirm', { selections: [
      { locator: session.username, contact_id: contactId },
    ] })).status, 200);
    assert.equal((await fixture.request('/api/sync/enable', {})).status, 200);
    const client = new ports.JsonClient(await ports.readConnection(fixture.infoPath));
    const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {},
      async requestJson(request) { return { ...await client.perform(request), generation: 1 }; } };
    const contacts = new ports.ContactSession(() => ports.readContactDirectory(backend));
    contacts.setConnection(1); await contacts.refreshContacts();
    const foreground = new ports.ForegroundController(backend, contacts);
    const observe = async (display_name, display_name_confidence = 0.5) => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify({
        capture_version: 'automatic-header-v3', display_name, display_name_confidence,
      }));
      await foreground.observeBeforeShow(); return foreground.getState();
    };
    try {
      assert.equal((await observe('合成侧试', 0.29)).reason, 'quality_unverified');
      for (const raw of ['合成测测试', '合测试', '合成侧试']) {
        const confirmed = await observe(raw);
        assert.equal(confirmed.phase, 'confirmed');
        assert.equal(confirmed.reason, 'confirmed_active_binding_name_match');
        assert.equal(confirmed.confirmedContactId, contactId);
        assert.equal(confirmed.recognizedName, raw);
        assert.equal(confirmed.recognitionConfidence, 0.5);
        assert.equal(foreground.getGenerationBlock(), null);
      }
      const unboundResult = await observe('未绑丁会话');
      assert.equal(unboundResult.reason, 'unmatched_requires_selection');
      assert.notEqual(foreground.getGenerationBlock(), null);
      assert.equal((await observe('合成侧试')).phase, 'confirmed');
      const competitor = { ...unbound, display_name: '合成侧式' };
      await fixture.setCli({ sessions: [session, competitor], messages: {} });
      assert.equal((await observe('合成侧试')).reason, 'ambiguous_requires_selection');
      assert.notEqual(foreground.getGenerationBlock(), null);
      await fixture.setCli({ sessions: [session], messages: {} });
      assert.equal((await observe('合成侧试')).reason, 'manual_confirmation_required');
      assert.notEqual(foreground.getGenerationBlock(), null);
      assert.equal((await fixture.tails()).includes(unbound.username), false, '名单匹配不授权未绑定会话正文读取');
    } finally { foreground.dispose(); }
  });
});
