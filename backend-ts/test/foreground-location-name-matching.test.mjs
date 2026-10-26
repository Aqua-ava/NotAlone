import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSessionNames, canonicalSessionName } from '../src/foreground/foreground-location-name-matching.ts';
const privateNames = (...names) => names.map(displayName => ({displayName, chatType:'private'}));
test('完整名称低分命中优先于编辑近邻，重复记录不授予身份', () => {
  assert.deepEqual(matchSessionNames('合成甲', .5, privateNames('合成甲','合成乙')), {kind:'unique',candidateIndex:0,method:'exact',plausibleIndices:[0]});
  assert.equal(matchSessionNames('合成甲', .5, privateNames('合成甲','合成甲')).kind, 'ambiguous');
});
test('完整名单编辑纠错保留所有竞争者及真实文字锚点', () => {
  assert.equal(matchSessionNames('合成丙', .5, privateNames('合成甲')).method, 'edit');
  assert.equal(matchSessionNames('合成丙', .5, privateNames('合成甲','合成乙')).kind, 'ambiguous');
  assert.equal(matchSessionNames('ßQ', .5, privateNames('ssX')).kind, 'unmatched');
  assert.equal(matchSessionNames('™AB', .5, privateNames('TMAC')).kind, 'unmatched');
  assert.equal(matchSessionNames('A', .5, privateNames('A')).kind, 'unmatched');
});
test('尾部证据与原文候选取并集，无效尾部不得回退高分原文', () => {
  assert.equal(matchSessionNames('遥远对象', 1, privateNames('遥远对象','合成🐯'), {tailText:'合成',tailConfidence:1}).kind,'ambiguous');
  assert.equal(matchSessionNames('其他', 0, privateNames('合成🐯'), {tailText:'合成',tailConfidence:1}).method,'tail');
  assert.equal(matchSessionNames('合成', 1, privateNames('合成'), {tailText:'',tailConfidence:1}).kind,'quality-unverified');
});
test('Python 空白、casefold、数字锚点和非BMP码点保持既有合同', () => {
  assert.equal(canonicalSessionName('\u001cＡ\u0085Straße\ufeff'), 'astrasse\ufeff');
  assert.equal(canonicalSessionName('\ua7f1'), '\ua7f1');
  assert.equal(matchSessionNames('𠀀𠀁', .5, privateNames('𠀀𠀁')).kind,'unique');
  assert.equal(matchSessionNames('𠀀'.repeat(256), 1, privateNames('𠀀'.repeat(256))).kind,'unique');
  assert.equal(matchSessionNames('①②', .5, privateNames('12')).kind,'unique');
  assert.equal(matchSessionNames('\u{1c89}\u{1c8a}', .5, privateNames('\u{1c89}\u{1c8a}')).kind,'unmatched');
});
test('质量、类型和全名单元数据失败关闭；取消向调用方传播', () => {
  for (const confidence of [true, false, NaN, Infinity, -.1, 1.1, null, '1']) assert.equal(matchSessionNames('合成', confidence, privateNames('合成')).kind,'quality-unverified');
  for (const name of [null, true, '甲'.repeat(257), 'ﬃ'.repeat(100)]) assert.equal(matchSessionNames('合成',1,privateNames('合成',name)).kind,'quality-unverified');
  assert.equal(matchSessionNames('合成',1,[{displayName:'合成',chatType:'unknown'}]).kind,'unmatched');
  assert.equal(matchSessionNames('合成',1,[{displayName:'合成',chatType:'group'},...privateNames('合成')]).kind,'group');
  let calls = 0;
  assert.throws(() => matchSessionNames('合成',.5,privateNames(...Array.from({length:1000},(_,i)=>`对象${i}`)), {checkCurrent(){if (++calls === 3) throw Error('合成取消');}}), /合成取消/);
});
test('冻结旧实现预期：合成名称、尾部、Unicode 与边界', async () => {
  const {readFile} = await import('node:fs/promises');
  const {names, expected} = JSON.parse(await readFile(new URL('./fixtures/foreground-name-matching-frozen.json', import.meta.url), 'utf8'));
  const cases = [];
  for (let i=0;i<names.length;i++) for(let j=0;j<names.length;j++) {
    cases.push([names[i],.5,privateNames(names[j]),{}]);
    cases.push([names[i],1,[...privateNames(names[j]),{displayName:names[(j+3)%names.length],chatType:j%3?'private':'group'}],{tailText:names[(i+5)%names.length],tailConfidence:1}]);
  }
  assert.equal(expected.length, cases.length);
  for(let i=0;i<cases.length;i++) assert.deepEqual(matchSessionNames(...cases[i]),expected[i],JSON.stringify(cases[i]));
});
test('五千长共同前缀名单在有界预算内保留歧义', () => {
  const names=privateNames(...Array.from({length:5000},(_,i)=>'A'.repeat(250)+String(i).padStart(4,'0')));
  const start=performance.now();
  assert.equal(matchSessionNames('A'.repeat(250)+'000X',.5,names).kind,'ambiguous');
  assert.ok(performance.now()-start<2000,'合成5000名单应在两秒内完成');
});
