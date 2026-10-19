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
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-emoji-http-'));
await writeFile(path.join(directory, 'production.mjs'), production.outputFiles[0].text);
const ports = await import(path.join(directory, 'production.mjs'));
after(() => rm(directory, { recursive: true, force: true }));

test('同图尾部文字经认证HTTP恢复质量门，前缀碰撞撤销身份且不能静默恢复', async () => {
  await ports.withVerifiedForegroundFixture(async fixture => {
    const contactId = fixture.data.contact_ids[0];
    const session = { username: 'wxid_synthetic_emoji', display_name: '合成🐯',
      chat_type: 'private', last_timestamp: 1700000000 };
    await fixture.setCli({ sessions: [session], messages: {} });
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
    const observe = async state => {
      await writeFile(path.join(fixture.directory, 'probe-state.json'), JSON.stringify(state));
      await foreground.observeBeforeShow(); return foreground.getState();
    };
    const raw = { capture_version: 'automatic-header-v3', display_name: '合成學', display_name_confidence: 0.3 };
    const fallback = { ...raw, capture_version: 'automatic-header-v4', text_fallback: {
      version: 'isolated-color-tail-v1', text: '合成', confidence: 0.95, text_complete: true, mask_verified: true,
    } };
    try {
      assert.equal((await observe(raw)).reason, 'quality_unverified');
      const confirmed = await observe(fallback);
      assert.equal(confirmed.phase, 'confirmed');
      assert.equal(confirmed.reason, 'confirmed_active_binding_emoji_fallback');
      assert.equal(confirmed.confirmedContactId, contactId);
      assert.equal(confirmed.recognizedName, '合成學');
      assert.equal(confirmed.recognitionConfidence, 0.3);
      assert.equal(foreground.getGenerationBlock(), null);
      await fixture.setCli({ sessions: [session, { ...session, username: 'wxid_synthetic_unbound', display_name: '合成A' }], messages: {} });
      assert.equal((await observe(fallback)).reason, 'ambiguous_requires_selection');
      assert.notEqual(foreground.getGenerationBlock(), null);
      await fixture.setCli({ sessions: [session], messages: {} });
      assert.equal((await observe(fallback)).reason, 'manual_confirmation_required');
      assert.notEqual(foreground.getGenerationBlock(), null);
    } finally { foreground.dispose(); }
  });
});
