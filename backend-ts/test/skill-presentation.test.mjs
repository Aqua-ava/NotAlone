import test from 'node:test';
import assert from 'node:assert/strict';
import {skillPresentation} from '../src/skills/sqlite/presentation.ts';

test('内置场景 Skill 按包名返回中文标题，目录之外的包没有展示信息', () => {
 assert.equal(skillPresentation('romance-007-short-reply')?.title,'对方只回“哈哈”、表情或短词');
 assert.equal(skillPresentation('romance-016-playful-banter')?.title,'接住对方的玩笑、调侃和轻挑战');
 assert.equal(skillPresentation('不存在的包'),undefined);
});
