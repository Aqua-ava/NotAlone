"""只准备本轮私有源码副本和公开观察补丁；不启动宿主或连接数据库。"""
from pathlib import Path
import os, json, hashlib, subprocess, io, tarfile, difflib, ast
os.umask(0o077)
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[3]
PRIVATE=Path(os.environ['NOTALONE_BOUNDARY_PRIVATE'])/'run-v1'
STATE=Path(os.environ['NOTALONE_HTTP_FIXTURE_STATE'])
BASE='1e90d9edde3a5c3ac0de08c018149dd79bbebdfc'
PRIVATE.mkdir(mode=0o700,exist_ok=False)
plan=json.loads((STATE/'plan.json').read_text())
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
archive=subprocess.check_output(['git','archive',BASE,'backend/database','backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'],cwd=REPO)
for label in ['baseline-source','observer-source']:
 root=PRIVATE/label;root.mkdir(mode=0o700)
 with tarfile.open(fileobj=io.BytesIO(archive)) as stream:stream.extractall(root,filter='data')
 for p in root.rglob('*'):p.chmod(0o700 if p.is_dir() else 0o600)
 (root/'backend-ts/node_modules').symlink_to(Path(plan['dependencies']),target_is_directory=True)
base=PRIVATE/'baseline-source';observed=PRIVATE/'observer-source'
helper="const __naMark = (label: string, meta?: unknown) => (globalThis as any)[Symbol.for('notalone.boundary.v1')]?.mark(label, meta);\nconst __naDone = (label: string, value: any): any => { __naMark(label); return value; };\n"
changes=[];query_labels=[]
def edit(file,transform):
 p=observed/'backend-ts/src'/file;old=p.read_text();new=transform(old)
 assert old!=new,file
 p.write_text(helper+new)
 changes.append({'path':'backend-ts/src/'+file,'before_sha256':sha(base/'backend-ts/src'/file),'after_sha256':sha(p)})
def once(text,old,new):
 if text.count(old)!=1:raise ValueError('unique_marker_not_found:'+old[:65]+':'+str(text.count(old)))
 return text.replace(old,new)
def queries(text,prefix):
 needle='await client.query(';cursor=0;out=[];n=0
 while True:
  start=text.find(needle,cursor)
  if start<0:out.append(text[cursor:]);break
  op=start+len('await client.query');i=op+1;depth=1;quote=None
  while i<len(text) and depth:
   c=text[i]
   if quote:
    if c=='\\':i+=2;continue
    if c==quote:quote=None
   elif c in "'\"`":quote=c
   elif c=='(':depth+=1
   elif c==')':depth-=1
   i+=1
  if depth:raise ValueError('unbalanced_query')
  n+=1;label=f'{prefix}.query.{n:02d}'
  query_labels.append({'label':label,'source_line':text.count('\n',0,start)+1,'query_expression_sha256':hashlib.sha256(text[start:i].encode()).hexdigest()})
  out.append(text[cursor:start]);out.append(f"__naDone('{label}.after', await (__naMark('{label}.before'), "+text[start+len('await '):i]+'))')
  cursor=i
 return ''.join(out)
def host(text):
 text=once(text,"const server=createServer(async(req,res)=>{","const server=createServer(async(req,res)=>{\n    __naMark('handler.enter');")
 text=once(text,"const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(stringifyJson(value));};","const respond=(status:number,value:unknown)=>{__naMark('respond.begin');res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(stringifyJson(value));__naMark('response.end.return');};")
 text=once(text,'if(await skills.privateHttp(req,res))return;',"__naMark('private.before');if(await skills.privateHttp(req,res)){__naMark('private.handled');return;}__naMark('private.after');")
 text=once(text,'let releaseAuthority:(()=>void)|undefined;',"__naMark('auth.done');\n    let releaseAuthority:(()=>void)|undefined;")
 text=once(text,'if(pureTs&&modelRuntime&&await modelRuntime.handlePublic(req,res,url))return;',"__naMark('public.before');if(pureTs&&modelRuntime&&await modelRuntime.handlePublic(req,res,url)){__naMark('public.handled');return;}__naMark('public.after');")
 text=once(text,'const lease=handoff.enter();',"__naMark('handoff.before');const lease=handoff.enter();__naMark('handoff.after');")
 text=once(text,'const result=await contacts.handle(req.method!,url,body,lease.assertCurrent,internal);',"__naMark('context.call');const result=await contacts.handle(req.method!,url,body,lease.assertCurrent,internal);__naMark('context.return');")
 text=once(text,'lease.assertCurrent();respond(200,result);',"lease.assertCurrent();__naMark('handoff.asserted');respond(200,result);")
 text=once(text,'} finally {lease.finish();}',"} finally {lease.finish();__naMark('handoff.finished');}")
 text=once(text,'taskEvents?.start();',"taskEvents?.start();__naMark('host.ready',modelRuntime?.replyStatus.state??'none');__naMark('host.taskEvents',Boolean(taskEvents));__naMark('host.maintenance',Boolean(maintenance));")
 return text
def storage(text):
 head='private async withClient<T>(write: boolean, operation: (client: pg.Client) => Promise<T>, business = false): Promise<T> {'
 text=once(text,head,head+"\n    __naMark('storage.enter');")
 pos=text.index(head);a=text[:pos];b=text[pos:]
 b=once(b,'const configuration = await connectionOptions(this.databaseUrl, this.values);',"__naMark('config.before');const configuration = await connectionOptions(this.databaseUrl, this.values);__naMark('config.after');")
 b=once(b,"if (business && String(configuration.options.host).startsWith('/') && !configuration.options.ssl) {","__naMark('acquire.before');if (business && String(configuration.options.host).startsWith('/') && !configuration.options.ssl) {")
 b=once(b,'if (business) stopObserving = trackQueryFailures(client, queryFailures);',"if (business) stopObserving = trackQueryFailures(client, queryFailures);__naMark('acquire.after');")
 b=once(b,'try { result = await operation(lease?.client ?? client); }',"__naMark('operation.before');try { result = await operation(lease?.client ?? client);__naMark('operation.after'); }")
 b=once(b,"await client.query('COMMIT');","__naMark('commit.before');await client.query('COMMIT');__naMark('commit.after');")
 b=once(b,'if (connection) await this.releaseBusinessConnection(connection, committed && !queryFailures.size && Boolean(lease?.reusable()));',"__naMark('release.before');if (connection) await this.releaseBusinessConnection(connection, committed && !queryFailures.size && Boolean(lease?.reusable()));")
 b=once(b,'} finally { lease?.cleanupListeners(); this.pending.delete(pending); finish(); }',"} finally { lease?.cleanupListeners(); this.pending.delete(pending); finish();__naMark('storage.exit'); }")
 b=once(b,'const code = await this.inspect(client);',"__naMark('inspect.before');const code = await this.inspect(client);__naMark('inspect.after');")
 b=once(b,'const metadataPending = client.query(`WITH catalog_rows AS (',"__naMark('catalog.dispatch');const metadataPending = client.query(`WITH catalog_rows AS (")
 b=once(b,'try { migrations = this.migrationFiles(); }',"try { __naMark('files.before');migrations = this.migrationFiles();__naMark('files.after'); }")
 b=once(b,'const snapshot = (await metadataPending).rows[0] as SchemaInspection;',"__naMark('catalog.await');const snapshot = (await metadataPending).rows[0] as SchemaInspection;__naMark('catalog.result');")
 return queries(a+b,'storage')
def context(text):
 text=once(text,'assertCurrent();\n    const owner=',"__naMark('context.enter');assertCurrent();\n    const owner=")
 return queries(text,'contact')
def public(text):
 text=once(text,"const respond=(status:number,body:unknown)=>{if(!res.destroyed&&!res.writableEnded)res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(stringifyJson(body));};","const respond=(status:number,body:unknown)=>{if(!res.destroyed&&!res.writableEnded){__naMark('respond.begin');res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(stringifyJson(body));__naMark('response.end.return');}};")
 text=once(text,'const bytes=await readWechatHttpBody(req,1024*1024);',"__naMark('body.before');const bytes=await readWechatHttpBody(req,1024*1024);__naMark('body.after');")
 text=once(text,"if(path==='/api/reply/generate'){","__naMark('body.parsed');if(path==='/api/reply/generate'){")
 text=once(text,"result={session_id:await service.defaultSession(scope)};","__naMark('session.before');result={session_id:await service.defaultSession(scope)};__naMark('session.after');")
 text=once(text,"const result=req.headers['x-notalone-manual-contact']===contact","__naMark('scope.dispatch.before');const result=req.headers['x-notalone-manual-contact']===contact")
 text=once(text,'respond(200,result);',"__naMark('scope.dispatch.after');respond(200,result);")
 return text
def json_host(text):
 text=once(text,'export function stringifyJson(value: unknown): string {',"export function stringifyJson(value: unknown): string {\n  __naMark('json.before');")
 return once(text,'return result;',"__naMark('json.after');return result;")
def tasks(text):
 text=once(text,'const work=(async()=>{',"const work=(async()=>{__naMark('task.refresh.before');")
 text=once(text,'})().finally(()=>{',"__naMark('task.refresh.after');})().finally(()=>{")
 return text
for file,transform in [('host-plugin.ts',host),('host-storage.ts',storage),('contact-context.ts',context),('pure-ts-public-api.ts',public),('host-json.ts',json_host),('pure-ts-task-events.ts',tasks)]:edit(file,transform)
patch=''
for item in changes:
 rel=item['path'];patch+=''.join(difflib.unified_diff((base/rel).read_text().splitlines(True),(observed/rel).read_text().splitlines(True),fromfile='a/'+rel,tofile='b/'+rel))
(HERE/'observer.patch').write_text(patch)
manifest={'status':'prepared_not_run','production_base_commit':BASE,'observer_changes':changes,'query_labels':query_labels,'base_source_sha256':{},'observer_source_sha256':{},'new_pg_query_or_callback_patch':False,'new_async_hooks':False,'new_gc_observer':False,'no_product_source_changes':True}
for label,root in [('base_source_sha256',base),('observer_source_sha256',observed)]:
 manifest[label]={str(p.relative_to(root)):sha(p) for p in root.rglob('*') if p.is_file() and 'node_modules' not in p.parts}
(PRIVATE/'prepared.json').write_text(json.dumps(manifest,indent=2)+'\n')
(HERE/'source-preparation.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'prepared':True,'changed_source_files':len(changes),'query_labels':len(query_labels),'source_files':len(manifest['base_source_sha256']),'no_host_or_pg_started':True}))
