import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

// 用户可感知动作失败不得静默：以下生产页面必须保留可见错误出口。
// 只检查源码契约，不启动 App、后端或浏览器。
const silentCatch = /\.catch\(\s*(?:\(\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/;
const required = {
  'src/renderer/SkillLearningPage.tsx': [/run\(configure\(/, /run\(bridge\.refresh\(/, /run\(bridge\.resume\(/,
    /run\(bridge\.openHistory\(/],
  'src/renderer/backend-status.tsx': [/重试连接未成功/, /重试停读尚未获确认/],
  'src/renderer/RewritePanel.tsx': [/复制来源记录未保存/],
};

test('用户动作失败不再静默吞掉', async () => {
  for (const [file, patterns] of Object.entries(required)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, silentCatch, `${file} 仍存在静默 catch`);
    for (const pattern of patterns) assert.match(source, pattern, `${file} 缺少可见错误路径 ${pattern}`);
  }
});

test('Skill 页面保留统一的可见错误出口', async () => {
  const source = await readFile('src/renderer/SkillLearningPage.tsx', 'utf8');
  assert.match(source, /const run = [^;]+setError\(/, 'Skill 动作须复用 run() 统一 setError');
  assert.match(source, /\{error && <p role="alert">\{error\}/, 'Skill 动作失败须有可见 alert');
});

test('连接状态页重试失败有可见文案而不只是状态位', async () => {
  const source = await readFile('src/renderer/backend-status.tsx', 'utf8');
  assert.match(source, /\{actionError && <p role="alert">\{actionError\}<\/p>\}/, '重试失败须渲染 alert');
});
