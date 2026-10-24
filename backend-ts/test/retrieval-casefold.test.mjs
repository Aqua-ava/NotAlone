import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {casefold,normalizationBarriers} from '../src/retrieval-casefold.ts';
const python=homedir()+'/miniconda3/envs/NotAlone/bin/python';
test('固定表逐码点匹配旧Python Unicode15，新增Unicode不改变旧身份语义',()=>{
 const script="import json,sys,unicodedata\nassert unicodedata.unidata_version=='15.0.0'\nprint(json.dumps({chr(i):chr(i).casefold() for i in range(0x110000) if chr(i)!=chr(i).casefold()}))";
 const expected=JSON.parse(execFileSync(python,['-c',script],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}));
 assert.deepEqual(casefold,expected);
});
test('规范化屏障精确覆盖Node当前版本与旧Python的兼容分解差异',()=>{
 const points=[];for(let cp=0;cp<=0x10ffff;cp++){const text=String.fromCodePoint(cp);if(text.normalize('NFKC')!==text)points.push(text);}
 const script="import json,sys,unicodedata\nprint(json.dumps([unicodedata.normalize('NFKC',x) for x in json.load(sys.stdin)]))";
 const expected=JSON.parse(execFileSync(python,['-c',script],{input:JSON.stringify(points),encoding:'utf8',timeout:10000,maxBuffer:1024*1024}));
 const differences=points.filter((text,index)=>text.normalize('NFKC')!==expected[index]);
 assert.deepEqual([...normalizationBarriers].sort(),differences.sort());
 assert.ok(differences.every(text=>expected[points.indexOf(text)]===text));
});
