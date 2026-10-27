import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {startModelPermitServer} from '../src/platform/models/model-permit-server.ts';
import {ModelLedgerError} from '../src/platform/models/model-ledger.ts';

// 隔离协议测试：故障由宿主记账端口注入，不代表数据库删除全链。
const privateText='合成内部正文，不得出现在协议中';
const cases=[
 ['原台账类型和删除code',new ModelLedgerError('model_ledger_scope_deleted'),true],
 ['普通Error同message',new Error('model_ledger_scope_deleted'),false],
 ['普通Error伪造code',Object.assign(new Error(privateText),{code:'model_ledger_scope_deleted'}),false],
 ['其他台账code',new ModelLedgerError(privateText),false],
 ['普通对象伪造code',{code:'model_ledger_scope_deleted',message:privateText},false],
 ['已确认类型不透传message',Object.assign(new ModelLedgerError('model_ledger_scope_deleted'),{message:privateText}),true],
];
for(const [name,error,deleted] of cases)test('Unix受限删除原因：'+name,{timeout:10000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-scope-reason-')),path=join(directory,'p.sock'),token='synthetic-scope-token-'.repeat(3);
 let received;
 const server=await startModelPermitServer({path,token,arbiter:new ModelPermitArbiter(1),accounting:{reserve:async()=>{},recordReserved:async receipt=>{received=receipt;throw error;}}});
 t.after(async()=>{await server.shutdown();await rm(directory,{recursive:true,force:true});});
 const socket=connect(path),lines=createInterface({input:socket})[Symbol.asyncIterator]();t.after(()=>socket.destroy());await once(socket,'connect');
 const receipt={synthetic:'原样只供协议测试'};
 socket.write(JSON.stringify({op:'record',token,receipt})+'\n');
 const line=(await lines.next()).value;
 assert.deepEqual(JSON.parse(line),deleted?{state:'accounting_rejected',reason:'scope_deleted'}:{state:'accounting_rejected'});
 assert.equal(line.includes(privateText),false);assert.equal(line.includes('model_ledger_scope_deleted'),false);
 assert.deepEqual(received,receipt);
});
