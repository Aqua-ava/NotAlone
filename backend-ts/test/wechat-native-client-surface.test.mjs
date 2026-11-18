// 特征测试：钉住 native-client.ts 的值导出面；拆出协议文件后，协议部分必须保持纯函数（无进程与文件 I/O），
// 且目录外仍只经 native-client.ts 导入。重构前（尚无 native-protocol.ts）相关断言自动跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const wechatDir = join(root, 'src/history/wechat');
const clientFile = join(wechatDir, 'native-client.ts');
const protocolFile = join(wechatDir, 'native-protocol.ts');

test('native-client 只对外导出 NarrowWechatClient 一个值', async () => {
  const api = await import(clientFile);
  assert.deepEqual(Object.keys(api), ['NarrowWechatClient']);
  assert.equal(typeof api.NarrowWechatClient, 'function');
  assert.equal(api.NarrowWechatClient.name, 'NarrowWechatClient');
});

test('NarrowWechatClient 保持原有公开方法集合', async () => {
  const {NarrowWechatClient} = await import(clientFile);
  const methods = Object.getOwnPropertyNames(NarrowWechatClient.prototype).filter(name => name !== 'constructor').sort();
  assert.deepEqual(methods, JSON.parse(readFileSync(new URL('./fixtures/history/native-client-methods.json', import.meta.url), 'utf8')));
});

test('协议文件不引入进程与文件 I/O（无协议文件时跳过）', {skip: !existsSync(protocolFile)}, () => {
  const source = readFileSync(protocolFile, 'utf8');
  for (const forbidden of ['node:child_process', 'node:fs', 'node:path', 'node:stream', 'node:net', 'process.env']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') yield* sourceFiles(path);
    } else if (/\.(ts|mjs)$/.test(name)) yield path;
  }
}

test('目录外与测试只经 native-client.ts 导入，不直接触达协议文件', {skip: !existsSync(protocolFile)}, () => {
  const deep = new RegExp(`${'native'}-protocol(?:\\.ts)?['"\`]`);
  const offenders = [];
  for (const base of [join(root, 'src'), join(root, 'test')]) {
    for (const file of sourceFiles(base)) {
      if (file === clientFile || file === fileURLToPath(import.meta.url)) continue;
      if (deep.test(readFileSync(file, 'utf8'))) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
