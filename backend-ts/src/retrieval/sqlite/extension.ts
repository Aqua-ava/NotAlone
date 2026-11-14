import type {DatabaseSync} from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import {installRetrievalIndexMaintenance} from './text-index.ts';

/** 受信任构建只加载固定依赖；连接交给业务动作前关闭扩展加载入口。 */
export function loadRetrievalExtension(db:DatabaseSync):void{
 try{sqliteVec.load(db);}finally{db.enableLoadExtension(false);}
}

/** 隔离夹具及可信附属连接的统一装配；构造连接时须allowExtension:true。 */
export function configureRetrievalConnection(db:DatabaseSync):ReturnType<typeof installRetrievalIndexMaintenance>|undefined{
 loadRetrievalExtension(db);
 return db.prepare("SELECT 1 FROM sqlite_schema WHERE name='retrieval_document'").get()?installRetrievalIndexMaintenance(db):undefined;
}
