/** 安装pg Result的纯内存契约单例；不创建Client、不连接PG。 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(path.join(process.argv[2],'backend-ts/package.json'));
const Result=require(path.join(path.dirname(require.resolve('pg')),'result.js'));
const result=new Result();
result.addCommandComplete({text:'EXPLAIN'});
result.rows=[{'QUERY PLAN':[{'Plan':{'Node Type':'Result'}}]}];
assert.equal(result.command,'EXPLAIN');assert.equal(result.rowCount,null);
assert.ok(Array.isArray(result.rows)&&result.rows.length===1&&Array.isArray(result.rows[0]['QUERY PLAN']));
console.log(JSON.stringify({command:result.command,rowCount:result.rowCount,rows_length:result.rows.length,corrected_shape_contract:true,pg_connections:0}));
