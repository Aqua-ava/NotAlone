// 当前 TS 事务设置的合成库探测，不写业务表。
import { HostStorage } from '../../../../backend-ts/src/host-storage.ts';
const storage=await HostStorage.open({envFilePath:'synthetic-disabled.env',migrationsDirectory:new URL('../../../../backend/database/migrations/',import.meta.url).pathname,environment:{NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:process.env.NOTALONE_SETTINGS_DATABASE}});
const query=`SELECT current_setting('transaction_isolation') AS transaction_isolation,current_setting('transaction_read_only') AS transaction_read_only,current_setting('search_path') AS search_path,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout`;
try {console.log(JSON.stringify({business_read:(await storage.businessReadTransaction(async client=>(await client.query(query)).rows[0])),business_write:(await storage.businessTransaction(async client=>(await client.query(query)).rows[0]))}));}
finally {await storage.close();}
