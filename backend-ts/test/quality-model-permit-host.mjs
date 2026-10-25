/** 隔离合成许可宿主：用真正退出的PID验证重启未知保护。 */
import pg from 'pg';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
const config=JSON.parse(process.env.NOTALONE_QUALITY_PERMIT_CONFIG);
if(!config.database.startsWith('notalone_quality_model_')||!config.database.endsWith('_test'))throw new Error('synthetic_database_required');
const pool=new pg.Pool({host:'/tmp',database:config.database,max:4});
const transaction=async work=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
};
let permit;
const accounting=createHostModelAccounting({transaction,provider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>permit?.unconfirmedPermitIds()??[]});
permit=await startModelPermitServer({path:config.socket,token:config.token,arbiter:new ModelPermitArbiter(2),accounting});
process.send({ready:true,ids:permit.unconfirmedPermitIds()});
process.on('message',async message=>{
  if(message.op==='snapshot')process.send({id:message.id,ids:permit.unconfirmedPermitIds()});
  if(message.op==='shutdown'){
    await permit.shutdown();await pool.end();process.send({id:message.id,ids:[]},()=>process.exit(0));
  }
});
