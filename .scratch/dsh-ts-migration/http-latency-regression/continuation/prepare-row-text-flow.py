"""从已保留H1驱动派生一个有限诊断；本文件本身不启动数据库或宿主。"""
from pathlib import Path
import ast

here=Path(__file__).resolve().parent
text=(here/'http-startup-idle-counterfactual.py').read_text()
def replace(old,new):
    global text
    assert old in text,old[:80]
    text=text.replace(old,new)

replace('http-startup-idle-counterfactual','http-row-text-counterfactual')
replace('startup-idle-counterfactual','row-text-counterfactual')
replace('owned = set()','owned = set()\nowned_all = set()')
replace('    owned.add(name)','    owned.add(name);owned_all.add(name)')
replace("            if phase=='settled2s':time.sleep(2) # 仅诊断固定空闲，不是就绪轮询或额外请求预热。\n",'')
replace("    source_base_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()", "    source_base_commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()\n    if source_base_commit!='1e90d9edde3a5c3ac0de08c018149dd79bbebdfc': raise RuntimeError('unexpected_source_head')\n    output['source_head']=source_base_commit")
replace("    target='backend-ts/src/host-storage.ts'\n    shutil.copyfile(REPO/target,fixed/target)", """    target='backend-ts/src/contact-context.ts'
    candidate=HERE/'contact-context-revision-text.candidate.ts'
    if sha(base/target)!='6e2a90f91f5013a08ec1e08c78f2e5716f2f3776b654e9a22d206c54e8512944' or sha(candidate)!='531e11a6db87ecd00f41f12db80376fea18be98cb5bdc2e3945d99d9efab8f48': raise RuntimeError('candidate_binding_mismatch')
    shutil.copyfile(candidate,fixed/target)
    for root in [base,fixed]:
        if sha(root/'backend-ts/src/host-storage.ts')!='0c96568ae4d608beda97af03bbaba696f07148627ecae153b1692dc52ee94f25': raise RuntimeError('storage_pin_mismatch')""")
replace("'host_storage_sha256':sha(root/target)","'contact_context_sha256':sha(root/target),'host_storage_sha256':sha(root/'backend-ts/src/host-storage.ts')")
replace("    output['hypothesis']='ready后初始化/JIT/初次后台活动重叠；只改变诊断采样前固定2s空闲，全部功能保持。'", "    output['hypothesis']='范围版本相同SELECT由PG编码为JSON文本，减少Node的JSONB解码及stringify；三读、两锁、RC及后验回滚保持。'")
replace("    for phase,root in [('immediate',fixed),('settled2s',fixed)]:\n        for arm,project in [('old',Path(plan['old'])),('new',root)]: sample(phase,arm,project)", """    # 此导出接缝副本与两个实际HTTP源码副本分开。
    safety=work/'safety-source';safety.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:stream.extractall(safety,filter='data')
    (safety/'backend-ts/node_modules').symlink_to(Path(plan['dependencies']),target_is_directory=True)
    original=(base/target).read_text();candidate_text=(fixed/target).read_text()
    old_sql=original.split('async function scopeRevision',1)[1].split('client.query(`',1)[1].split('`,[owner,contact]);',1)[0]
    new_sql=candidate_text.split('async function scopeRevision',1)[1].split('client.query(`',1)[1].split('`,[owner,contact]);',1)[0]
    if old_sql not in new_sql:raise RuntimeError('scope_query_changed')
    for content in [original,candidate_text]:
        if content.count('await scopeRevision(')!=3 or content.count("await client.query('SELECT pg_advisory_xact_lock(")!=2:raise RuntimeError('scope_fence_changed')
    export='\\nexport { scopeRevision as syntheticScopeRevision };\\n'
    (safety/'backend-ts/src/contact-context.row-original.ts').write_text(original+export)
    (safety/target).write_text(candidate_text+export)
    db='na_hostperf_'+uuid.uuid4().hex+'_test';clone(plan,db);owned.add(db);owned_all.add(db)
    sfolder=work/'safety';sspec=specification({**plan,'new':str(safety)},'new',sfolder,db)
    private=Path(os.environ['NOTALONE_DIAGNOSTIC_RAW_DIR'])
    result_path=private/'row-text-safety-original.json'
    if result_path.exists():raise RuntimeError('safety_original_already_exists')
    sspec['environment'].update({'NOTALONE_ROW_PROBE_DATABASE':db,'NOTALONE_ROW_PROBE_OUTPUT':str(result_path)})
    with (private/'row-text-safety.stdout.log').open('x') as stdout,(private/'row-text-safety.stderr.log').open('x') as stderr:
        completed=subprocess.run([plan['node'],str(HERE/'row-text-probe.mjs')],cwd=sspec['cwd'],env=sspec['environment'],stdout=stdout,stderr=stderr,timeout=90)
    if result_path.exists():
        raw=result_path.read_bytes();safe=raw.decode().replace(str(work),'<owned-work>').replace(str(REPO),'<repo>').replace(str(Path.home()),'<user-home>')
        save('row-text-safety.json',json.loads(safe))
        output['safety']={'raw_sha256':hashlib.sha256(raw).hexdigest(),'public_sha256':sha(HERE/'row-text-safety.json'),'exit_code':completed.returncode}
    with psycopg.connect('host=/tmp dbname='+db) as connection:
        counts=connection.execute('SELECT (SELECT count(*) FROM model_call_receipt),(SELECT count(*) FROM outbound_ledger_entry)').fetchone()
    output['safety_model_records']={'model_call_receipt':counts[0],'outbound_ledger_entry':counts[1]}
    drop(db);owned.remove(db)
    if completed.returncode!=0:raise RuntimeError('row_text_safety_failed')
    for phase,root in [('baseline',base),('text',fixed)]:
        for arm,project in [('old',Path(plan['old'])),('new',root)]: sample(phase,arm,project)""")
replace("for phase in ['immediate','settled2s']:","for phase in ['baseline','text']:")
replace("if phase=='after' and (item[phase]['p50_ratio']>1.1 or item[phase]['p95_ratio']>1.1)","if phase=='text' and (item[phase]['p50_ratio']>1.15 or item[phase]['p95_ratio']>1.25)")
replace("output['cleanup']['owned_databases_remaining']=c.execute('SELECT count(*) FROM pg_database WHERE datname=ANY(%s)',[list(owned)]).fetchone()[0] if owned else 0", "output['cleanup']['owned_databases_remaining']=c.execute('SELECT count(*) FROM pg_database WHERE datname=ANY(%s)',[list(owned_all)]).fetchone()[0]\n        output['cleanup']['owned_sessions_remaining']=c.execute('SELECT count(*) FROM pg_stat_activity WHERE datname=ANY(%s)',[list(owned_all)]).fetchone()[0]\n        output['cleanup']['owned_database_count']=len(owned_all)")
ast.parse(text)
target=here/'http-row-text-counterfactual.py'
target.write_text(text);target.chmod(0o600)
print('row-text finite workflow prepared; no database or host started')
