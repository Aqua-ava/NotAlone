import {registry as base} from '../../../src/storage/sqlite/registry.ts';
export const domainMigration = {version:base.migrations.length+1,sql:`
CREATE TABLE scope(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,PRIMARY KEY(owner_id,contact_id)) STRICT;
CREATE TABLE fact(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,id TEXT NOT NULL,value INTEGER,kind TEXT NOT NULL,reference TEXT,
PRIMARY KEY(owner_id,contact_id,id),FOREIGN KEY(owner_id,contact_id) REFERENCES scope(owner_id,contact_id),
CHECK((kind='unknown' AND value IS NULL AND reference IS NULL) OR (kind='known' AND value IS NOT NULL AND reference IS NOT NULL))) STRICT;
CREATE UNIQUE INDEX one_reference ON fact(owner_id,contact_id,reference) WHERE reference IS NOT NULL;
`};
export const registry={migrations:[...base.migrations,domainMigration],actions:[
 {name:'facts.addScope',mode:'write',retryBusy:true,execute(tx,input){tx.run('INSERT INTO scope VALUES(?,?)',input);return 'committed';}},
 {name:'facts.save',mode:'write',retryBusy:false,execute(tx,input){tx.run('INSERT INTO fact VALUES(?,?,?,?,?,?)',input);return 'committed';}},
 {name:'facts.list',mode:'read',retryBusy:false,execute(tx,input){return tx.all('SELECT * FROM fact WHERE owner_id=? AND contact_id=?',input);}},
 {name:'facts.atomicFailure',mode:'write',retryBusy:false,execute(tx){tx.run("INSERT INTO scope VALUES('rollback','contact')");tx.run("INSERT INTO fact VALUES('missing','contact','bad',NULL,'unknown',NULL)");}},
 {name:'facts.asyncWrite',mode:'write',retryBusy:false,async execute(tx){await Promise.resolve();tx.run("INSERT INTO scope VALUES('async','contact')");}},
 {name:'facts.illegalReadWrite',mode:'read',retryBusy:false,execute(tx){tx.run("INSERT INTO scope VALUES('read','contact')");}},
 {name:'facts.compact',mode:'maintenance',retryBusy:false,execute(maintenance){const checkpoint=maintenance.checkpoint();if(checkpoint.busy!==0n)throw new Error('checkpoint_busy');maintenance.vacuum();return 'compacted';}},
 {name:'facts.crash',mode:'write',retryBusy:false,execute(tx){tx.run("INSERT INTO scope VALUES('crash','contact')");process.exit(42);}},
]};
