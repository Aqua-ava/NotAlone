import {writeFile} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';

/** 复用 Node schema、同库核对及排空；不另建或遗留管理连接。 */
export async function createExtractionFixture(){
 const fixture=await createStorageFixture();
 const database=fixture.client.connectionParameters.database;
 if(!/^notalone_ts_host_[a-f0-9]{32}_test$/.test(database))throw new Error('合成库身份不确定，保留现场');
 await writeFile(`${fixture.directory}/task10-owned-database.json`,JSON.stringify({database,pid:process.pid,task:'10'}),{mode:0o600});
 return fixture;
}
