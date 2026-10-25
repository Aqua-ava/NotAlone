/** 运行前后核对实际直接依赖版本/入口；不把锁文件等同全部依赖实现字节认证。 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function captureDependencies(root,python){
 const pkg=JSON.parse(await readFile(join(root,'backend-ts/package.json'),'utf8')),installed={};
 for(const [name,expected]of Object.entries({...pkg.dependencies,...pkg.devDependencies})){const directory=join(root,'backend-ts/node_modules',name),bytes=await readFile(join(directory,'package.json')),actual=JSON.parse(bytes);if(actual.version!==expected)throw Error('dependency_version_mismatch:'+name);let entry=null;if(typeof actual.main==='string'){try{entry=sha(await readFile(join(directory,actual.main)));}catch{}}installed[name]={version:actual.version,package_json_sha256:sha(bytes),declared_entry_sha256:entry};}
 const code="import json,hashlib,importlib.metadata,importlib.util\nnames={'httpx':'httpx','openai':'openai','langchain':'langchain','langchain_core':'langchain-core','langchain_deepseek':'langchain-deepseek','deepagents':'deepagents','psycopg':'psycopg'}\nout={}\nfor module,dist in names.items():\n spec=importlib.util.find_spec(module);out[module]={'version':importlib.metadata.version(dist),'entry_sha256':hashlib.sha256(open(spec.origin,'rb').read()).hexdigest()}\nprint(json.dumps(out))";
 const pythonPackages=JSON.parse(execFileSync(python,['-c',code],{env:{NOTALONE_DISABLE_DOTENV:'1',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:10000,maxBuffer:65536}));
 return {node:process.version,installed,python_packages:pythonPackages,scope:'直接版本/package与已声明入口前后核hash；非全部传递依赖实现字节认证'};
}
