import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

test('方法反馈证据沿预先捕获的目录写入，隔离环境清理不丢失本轮路径', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-feedback-evidence-'));
  const previous = process.env.NOTALONE_LEARNING_EVIDENCE_DIR;
  try {
    const compiled = await build({ stdin: { contents: "export { createSkillFeedbackEvidenceWriter } from './tests/headless/skill-feedback-evidence';",
      resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
    const { createSkillFeedbackEvidenceWriter } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    process.env.NOTALONE_LEARNING_EVIDENCE_DIR = directory;
    const writeEvidence = createSkillFeedbackEvidenceWriter(process.env.NOTALONE_LEARNING_EVIDENCE_DIR);
    delete process.env.NOTALONE_LEARNING_EVIDENCE_DIR;
    const receipt = { phase: 'failed', status: 409, reason: 'skill_policy_changed', requestKey: 'synthetic-original-key' };
    await writeEvidence('original', receipt);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^feedback-generation-original-[0-9a-f-]+\.json$/);
    const evidence = path.join(directory, files[0]);
    assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')), receipt);
    assert.equal((await stat(evidence)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.NOTALONE_LEARNING_EVIDENCE_DIR;
    else process.env.NOTALONE_LEARNING_EVIDENCE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
