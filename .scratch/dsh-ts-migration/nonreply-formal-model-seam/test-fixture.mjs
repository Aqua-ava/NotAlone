/** 只创建明确合成的 SQLite；不读取或复用任何真实问题账本。 */
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,chmod,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {bindExistingProblemBudget} from './problem-budget-port.mjs';
import {loadFrozenMaterials,createPlan,BASELINE} from '../resumed-nonreply-evaluation/runner.mjs';
export const REPO=fileURLToPath(new URL('../../../',import.meta.url));
export const PIN='4f89bb976dd4086a02b7ae983fee2760d6e4ff64';
let planPromise;
export function frozenPlan(){return planPromise??=loadFrozenMaterials().then(bundle=>createPlan(bundle,{newCommit:PIN}));}
export async function executorPorts(budget,{beforeWrite,send}={}){
  const plan=await frozenPlan(),runIds=plan.runs.slice(0,2).map(r=>r.run_id);
  const sourceValue={candidate_commit:PIN,old_commit:BASELINE,source_sha256:'a'.repeat(64)};
  const source={async assertCurrent(){return {...sourceValue};}};
  const state={permission:true,sourceValue,sends:0,opens:0};
  const business={async open(run){state.opens++;
    return {evidence:{runtime:run.arm==='new'?'typescript':'isolated_python',inner_problem_budget_bound:false,
      profile_sha256:'b'.repeat(64),model_host:'actual_product_contract',source_commit:run.commit},
      async assertCurrent(){return {scope:run.scope,source_sha256:'c'.repeat(64),lease_generation:1,task_id:'synthetic-task'};},
      async run(dispatch,signal){
        for(const route of ['messages','strict_chat']){
          const body={model:'deepseek-flash',temperature:0,max_tokens:4096,thinking:{type:'disabled'},
            messages:[{role:'user',content:'仅用合成文本验证非空发送'}],tools:[{name:route==='messages'?'DirectMemoryExtractionOutput':'SourceVerificationOutput',input_schema:{type:'object'}}]};
          await dispatch({raw:JSON.stringify(body),path:route==='messages'?'/anthropic/v1/messages':'/beta/chat/completions',route,signal});
        }
        return {terminal_status:'succeeded',business_output:{facts:[{text:'合成记录'}]},audit:{persisted_physical_count:2},trace_events:[]};
      },async close(){}};}};
  const supplier={validate:async()=>true,async send(input){await beforeWrite?.(input,state);const send_ack=await input.beforeWrite(input.request.raw);state.sends++;
    return send?send(input,send_ack):{send_ack,physical_attempted:true,terminal_status:'complete',response_sha256:'d'.repeat(64),response_model:null,response_fingerprint:null};}};
  return {plan,runIds,state,ports:{plan,source,business,budget,supplier,permission:{async assertAllowed(){return state.permission;}}}};
}
export async function budgetFixture({limit=4,deadline=Date.now()+60000}={}){
  const directory=await mkdtemp(join(tmpdir(),'notalone-seam-synthetic-budget-'));await chmod(directory,0o700);
  const path=join(directory,'synthetic.sqlite');
  const db=new DatabaseSync(path);await chmod(path,0o600);
  db.exec('CREATE TABLE budget(problem TEXT,max_calls INTEGER,deadline REAL,used INTEGER,streak INTEGER);CREATE TABLE rounds(id TEXT PRIMARY KEY,hypothesis TEXT,evidence TEXT,outcome TEXT)');
  db.prepare('INSERT INTO budget VALUES(?,?,?,0,0)').run('synthetic-nonreply-seam',limit,deadline/1000);
  db.prepare('INSERT INTO rounds VALUES(?,?,NULL,NULL)').run('synthetic-r1','仅验证唯一持久发送前额度');db.close();
  const moduleRoot=process.env.NA_SEAM_BUDGET_MODULE_ROOT??join(REPO,'backend/src');
  const configuration={python:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),moduleRoot,repositoryRoot:REPO,
    budget:{ledger:path,problem_id:'synthetic-nonreply-seam',round:'synthetic-r1'}};
  const port=await bindExistingProblemBudget({configuration,expected:{python:configuration.python,moduleRoot,repositoryRoot:REPO}});
  return {port,path,directory,configuration,expected:{python:configuration.python,moduleRoot,repositoryRoot:REPO},
    expire(){const db=new DatabaseSync(path);db.prepare('UPDATE budget SET deadline=?').run(Date.now()/1000-1);db.close();},
    read(){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT problem,max_calls,deadline,used,streak FROM budget').get();}finally{db.close();}},
    async close(){await rm(directory,{recursive:true,force:true});}};
}
