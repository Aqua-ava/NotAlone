import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('配对验证账号不一致时只输出固定错误码并关闭自有读取器',()=>{
 const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./fixtures/history/recovery-pair-privacy-probe.mjs',import.meta.url))],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/固定错误码、无私有字段、读者已关闭/);assert.doesNotMatch(result.stdout+result.stderr,/ACCOUNT_SENTINEL/);
});
