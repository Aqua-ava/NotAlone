import test from 'node:test';
import assert from 'node:assert/strict';
import { stringifyJson } from '../src/host/host-json.ts';

test('BigInt以原始JSON整数输出，正文不能伪装原始JSON插入', () => {
  assert.equal(stringifyJson({ revision: 9223372036854775807n, nested: [-9223372036854775808n, 9007199254740991, 9007199254740993n], text: '9223372036854775807' }),
    '{"revision":9223372036854775807,"nested":[-9223372036854775808,9007199254740991,9007199254740993],"text":"9223372036854775807"}');
  assert.equal(stringifyJson({ rawJSON: '1,"injected":true' }), '{"rawJSON":"1,\\"injected\\":true"}');
  assert.throws(() => stringifyJson(undefined));
});
