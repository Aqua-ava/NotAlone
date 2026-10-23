import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, stringifyJson } from '../src/host-json.ts';

test('公开JSON整数往返保留PostgreSQL bigint修订号，不改成字符串', () => {
  const source = '{"revision":9223372036854775807,"nested":[-9223372036854775808,9007199254740991,9007199254740993],"text":"9223372036854775807"}';
  const value = parseJson(source);
  assert.equal(value.revision, 9223372036854775807n);
  assert.deepEqual(value.nested, [-9223372036854775808n, 9007199254740991, 9007199254740993n]);
  assert.equal(value.text, '9223372036854775807');
  assert.equal(stringifyJson(value), source);
});

test('普通JSON与小数指数保持原类型，正文不能伪装原始JSON插入', () => {
  const value = parseJson('{"count":3,"flag":true,"none":null,"fraction":1.5,"exponent":1e3,"text":"中文🙂"}');
  assert.equal(typeof value.exponent, 'number');
  assert.equal(typeof parseJson('1e20'), 'number');
  assert.equal(value.fraction, 1.5);
  assert.deepEqual(parseJson(stringifyJson(value)), value);
  assert.equal(stringifyJson({ rawJSON: '1,"injected":true' }), '{"rawJSON":"1,\\"injected\\":true"}');
  assert.throws(() => parseJson('{"revision":01}'), SyntaxError);
  assert.throws(() => stringifyJson(undefined));
});
