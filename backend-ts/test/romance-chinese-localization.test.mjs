import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {romanceBundleRoot, validateRomanceBundle} from '../../scripts/validate_romance_reply_skills.mjs';

test('中文本地化保留来源绑定并用于 Skill 正文与案例', async () => {
  const {packages, summary} = await validateRomanceBundle();
  assert.equal(summary.packages, 92);
  assert.equal(summary.localizedExcerpts, 33);

  const firstContact = packages.find(item => item.entry.name === 'romance-001-first-contact');
  assert.ok(firstContact);
  assert.match(firstContact.pkg.content, /优质开场的构成/);
  assert.match(firstContact.pkg.content, /观察 → 发挥 → 邀请/);
  assert.doesNotMatch(firstContact.pkg.content, /The Anatomy of a Great Opener/);
  const examples = firstContact.pkg.resources.find(item => item.relative_path === 'references/cases.md');
  assert.ok(examples);
  assert.match(examples.content.toString('utf8'), /从个人资料里的细节开场/);
  assert.doesNotMatch(examples.content.toString('utf8'), /Profile-Based Opener/);

  const translations = JSON.parse(await readFile(join(romanceBundleRoot, 'translations.json'), 'utf8'));
  assert.equal(translations.locale, 'zh-CN');
  assert.ok(translations.entries.every(item => /^[a-f0-9]{64}$/.test(item.source.excerpt_sha256)
    && item.source.excerpt_sha256 === item.excerpt_sha256 && item.source.start_line > 0));
});
