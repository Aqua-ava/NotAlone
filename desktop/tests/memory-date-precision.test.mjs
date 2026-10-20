import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const compiled = await build({ stdin: { contents: `
export { memoryTemporalFields } from './src/main/memory/read';
export { MemoryEventDetails } from './src/renderer/MemoryEventDetails';
export { createElement } from 'react';
export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle:true, packages:'external', jsx:'automatic', platform:'node', format:'cjs', write:false });
const module = { exports:{} };
new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const api = module.exports;
const id = '11111111-1111-4111-8111-111111111111';
const position = { message_id:id,char_start:0,char_end:8 };
const base = { version:2,stage:'occurred',stage_verified:true,stage_evidence:[position],
  occurrence_start:'2029-01-01T00:00:00+08:00',occurrence_end:'2030-01-01T00:00:00+08:00',
  occurrence_verified:true,occurrence_evidence:[position],occurrence_precision:'year',
  occurrence_expression:'去年',anchor_message_id:id };
test('同一HTTP记忆同时保留日期精度和独立条件来源', () => {
  const conditions = { version: 1, items: [{ text: '出差期间', evidence: [position], source_supported: true }] };
  const fields = api.memoryTemporalFields({ valid_at: null, invalid_at: null, event: base, conditions });
  assert.equal(fields.event.occurrencePrecision, 'year');
  assert.equal(fields.conditions.items[0].text, '出差期间');
  assert.equal(fields.conditions.items[0].sourceSupported, true);
  assert.equal(fields.conditions.items[0].evidence[0].messageId, id);
});
test('HTTP事件年/月精度在详情保留当地日历，不展示虚构的零点发生日期', () => {
  const { event } = api.memoryTemporalFields({valid_at:null,invalid_at:null,event:base});
  assert.equal(event.occurrencePrecision,'year');
  let html = api.renderToStaticMarkup(api.createElement(api.MemoryEventDetails,{event}));
  assert.match(html,/2029年/);
  assert.doesNotMatch(html,/2029年1月1日|00:00:00/);
  assert.match(html,/去年/);
  const monthly = api.memoryTemporalFields({valid_at:null,invalid_at:null,event:{...base,
    occurrence_start:'2029-12-01T00:00:00-07:00',occurrence_end:'2030-01-01T00:00:00-07:00',
    occurrence_precision:'month',occurrence_expression:'上月'}}).event;
  html = api.renderToStaticMarkup(api.createElement(api.MemoryEventDetails,{event:monthly}));
  assert.match(html,/2029年12月/);
  assert.doesNotMatch(html,/12月1日|00:00:00/);
});

test('旧事件保留已有绝对时间，未知v2保留原表达，计划不会按时钟变成已发生', () => {
  const old = {...base,version:1};
  delete old.occurrence_precision; delete old.occurrence_expression; delete old.anchor_message_id;
  const legacy = api.memoryTemporalFields({valid_at:null,invalid_at:null,event:old}).event;
  assert.equal(legacy.occurrencePrecision,undefined);
  assert.match(api.renderToStaticMarkup(api.createElement(api.MemoryEventDetails,{event:legacy})),/2029年1月1日/);
  const unknown = api.memoryTemporalFields({valid_at:null,invalid_at:null,event:{...base,
    stage:'planned',occurrence_start:null,occurrence_end:null,occurrence_verified:false,
    occurrence_precision:'unknown',occurrence_expression:'过阵子'}}).event;
  const html=api.renderToStaticMarkup(api.createElement(api.MemoryEventDetails,{event:unknown}));
  assert.match(html,/事件阶段：计划/);
  assert.match(html,/时间精度：未知；原话：过阵子/);
  assert.throws(() => api.memoryTemporalFields({valid_at:null,invalid_at:null,event:{...base,occurrence_precision:'unknown'}}));
});

test('跨多个日历单位显示完整期间且不把结束边界当发生日期', () => {
  for (const [precision,start,end,expected] of [
    ['day','2030-01-28T00:00:00+08:00','2030-02-04T00:00:00+08:00',/2030年1月28日 至 2030年2月3日/],
    ['month','2029-11-01T00:00:00-07:00','2030-02-01T00:00:00-07:00',/2029年11月 至 2030年1月/],
    ['year','2028-01-01T00:00:00+08:00','2031-01-01T00:00:00+08:00',/2028年 至 2030年/],
  ]) {
    const event=api.memoryTemporalFields({valid_at:null,invalid_at:null,event:{...base,
      occurrence_precision:precision,occurrence_start:start,occurrence_end:end}}).event;
    assert.match(api.renderToStaticMarkup(api.createElement(api.MemoryEventDetails,{event})),expected);
  }
});
