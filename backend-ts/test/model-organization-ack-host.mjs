/** 真许可server/journal/PG的独立进程；只接合成配置，不执行任务或模拟Worker。 */
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const here=resolve(new URL('.',import.meta.url).pathname),root=resolve(here,'../..');
const require=createRequire(join(root,'backend-ts/package.json')),pg=require('pg');
const {PostgresModelLedger,PostgresModelLedgerDetails}=await import(pathToFileURL(join(root,'backend-ts/src/model-ledger.ts')));
const {ModelPermitArbiter}=await import(pathToFileURL(join(root,'backend-ts/src/model-permits.ts')));
const {startModelPermitServer}=await import(pathToFileURL(join(root,'backend-ts/src/model-permit-server.ts')));
const {createHostModelAccounting}=await import(pathToFileURL(join(root,'backend-ts/src/host-model-accounting.ts')));
let server;
try{
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
    const message=JSON.parse(line);
    if(message.op==='shutdown'){await server?.shutdown();server=undefined;break;}
    if(server)throw new Error('synthetic_host_already_started');
    const transaction=async work=>{const c=new pg.Client({host:'/tmp',database:message.database});await c.connect();
      try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}
      catch(error){await c.query('ROLLBACK');throw error;}finally{await c.end();}};
    // 独立进程内直接使用正式源码依赖图，避免手抄文件清单遗漏新增传递依赖。
    const accounting=createHostModelAccounting({transaction,provider:'deepseek',model:'synthetic-model',unconfirmedPermitIds:()=>{if(!server)throw new Error('host_not_ready');return server.unconfirmedPermitIds();}});
    server=await startModelPermitServer({path:message.path,token:message.token,arbiter:new ModelPermitArbiter(1),accounting});
    const unknown=server.unknownSettlements();
    const ledger=new PostgresModelLedger({transaction,details:new PostgresModelLedgerDetails()});
    const recovered=await ledger.recoverUnknownPermits(unknown.map(item=>item.id));
    console.log(JSON.stringify({state:'ready',unknown:unknown.map(item=>({id:item.id,attempt_id:item.attempt_id})),recovered}));
  }
}finally{await server?.shutdown();}
