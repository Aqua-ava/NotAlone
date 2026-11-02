import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSqliteModelEnvironment,resolveBackgroundProcessingMode} from '../src/host/sqlite-model-config.ts';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'notalone-model-config-11-'));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,'model.env');}
test('SQLite模型配置保留环境优先与首个dotenv值，只读取模型键',async t=>{
 const file=await fixture(t);await writeFile(file,'# 合成配置\nNOTALONE_DEEPSEEK_API_KEY="synthetic-only"\nNOTALONE_OPENCODE_API_KEY=synthetic-opencode-only\nNOTALONE_DEEPSEEK_MODEL=first\nNOTALONE_DEEPSEEK_MODEL=second\nPGPASSWORD=synthetic-pg-unused\n', {mode:0o600});
 const value=await readSqliteModelEnvironment(file,{NOTALONE_DEEPSEEK_MODEL:'explicit',PGPASSWORD:'unused'});
 assert.equal(value.NOTALONE_DEEPSEEK_API_KEY,'synthetic-only');assert.equal(value.NOTALONE_OPENCODE_API_KEY,'synthetic-opencode-only');assert.equal(value.NOTALONE_DEEPSEEK_MODEL,'explicit');assert.equal(value.PGPASSWORD,undefined);
 const fromFile=await readSqliteModelEnvironment(file,{});assert.equal(fromFile.NOTALONE_DEEPSEEK_MODEL,'first');
});
test('禁用dotenv与缺失文件不猜测其他位置的凭据',async t=>{
 const file=await fixture(t);await writeFile(file,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only');
 assert.equal((await readSqliteModelEnvironment(file,{NOTALONE_DISABLE_DOTENV:'1'})).NOTALONE_DEEPSEEK_API_KEY,undefined);
 assert.deepEqual(await readSqliteModelEnvironment(file+'.missing',{}),{});
});
test('模型配置拒绝符号链接、目录与超长文件，错误不回显路径或正文',async t=>{
 const file=await fixture(t);await writeFile(file,'NOTALONE_DEEPSEEK_API_KEY=synthetic-only');await symlink(file,file+'.alias');
 const rejected=error=>error.code==='sqlite_model_configuration_invalid'&&!error.message.includes(file)&&!error.message.includes('synthetic-only');
 await assert.rejects(readSqliteModelEnvironment(file+'.alias',{}),rejected);await assert.rejects(readSqliteModelEnvironment(join(file,'..'),{}),rejected);
 await writeFile(file,'x'.repeat(1024*1024+1));await assert.rejects(readSqliteModelEnvironment(file,{}),rejected);
});


test('后台处理模式沿用明确env文件且环境优先，不读取其他位置',async t=>{
 const file=await fixture(t);await writeFile(file,'NOTALONE_BACKGROUND_PROCESSING=manual\n',{mode:0o600});
 assert.equal((await readSqliteModelEnvironment(file,{})).NOTALONE_BACKGROUND_PROCESSING,'manual');
 assert.equal((await readSqliteModelEnvironment(file,{NOTALONE_BACKGROUND_PROCESSING:'automatic'})).NOTALONE_BACKGROUND_PROCESSING,'automatic');
});


test('后台处理默认automatic，manual明确生效，非法值拒绝启动',()=>{
 assert.equal(resolveBackgroundProcessingMode({}),'automatic');assert.equal(resolveBackgroundProcessingMode({NOTALONE_BACKGROUND_PROCESSING:'manual'}),'manual');
 assert.throws(()=>resolveBackgroundProcessingMode({NOTALONE_BACKGROUND_PROCESSING:'typo'}),{code:'sqlite_background_configuration_invalid'});
});
