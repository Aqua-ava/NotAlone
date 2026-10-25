"""冻结本任务文件清单；不读写Git index，不创建提交。"""
from pathlib import Path
import hashlib,json,os,subprocess
base=Path(__file__).resolve().parent
repo=base.parents[3]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
product=['backend-ts/src/host-storage.ts','backend-ts/test/host-storage.test.mjs']
expected=json.loads((base/'product-bindings.json').read_text())
assert all(sha(repo/f)==expected[f]['current_sha256'] for f in product)
run=json.loads((base/'http-recheck.json').read_text());capture=json.loads((base/'http-recheck-capture.json').read_text())
rows_sha=lambda data:hashlib.sha256(json.dumps(data['rows'],sort_keys=True).encode()).hexdigest()
assert rows_sha(run)==rows_sha(capture)
assert len(run['rows'])==480 and all(row['terminal_status']=='succeeded' for row in run['rows'])
assert all(run['binding_before'].values()) and all(run['binding_after'].values()) and run['source_unchanged_after']
assert run['source_bindings']['after']['host_storage_sha256']==sha(repo/product[0])
assert len((base/'handoff.md').read_text().splitlines())<=40
assert not (base/'trace-source').exists()
violations=[]
for path in base.rglob('*'):
 if path.is_symlink():violations.append('unexpected_symlink:'+str(path.relative_to(base)));continue
 if path.is_dir():path.chmod(0o700);continue
 path.chmod(0o600)
 if path.suffix in ['.json','.log','.md','.patch','.mjs','.py']:
  content=path.read_text(errors='replace')
  if str(Path.home())+'/' in content or ('actual'+'-app') in content:violations.append('local_identity:'+str(path.relative_to(base)))
assert not violations,violations
freeze={
 'date':'2026-10-26 Asia/Taipei','frozen':True,'status':'partial_optimization_http_regression_remaining',
 'formal_performance_qualified':False,'formal_startups_and_rss_not_executed':True,
 'ticket_25_approved':False,'ticket_26_started':False,'root_exclusive_index_respected':True,
 'task_base_commit':'54aebef5ccad427d680ce243eb852c5bd4d91f1e',
 'observed_head_at_freeze':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
 'root_preflight_summary_sha256':sha(base.parent/'root-preflight-summary.json'),
 'product':[{ 'path':f,**expected[f]} for f in product],
 'product_patch_sha256':sha(base/'product.patch'),
 'http_all_observations_sha256':rows_sha(run),
 'http_after_source_sha256':run['source_bindings']['after']['sha256'],
 'http_original_capture_sha256':sha(base/'http-recheck-capture.json'),
 'dependency_sha256':run['dependencies_sha256'],'old_dependency_sha256':run['old_dependencies_sha256'],
 'settings_artifact_sha256':sha(base/'settings.json'),
 'checks':{'related_modules':{'passed':82,'failed':0,'skipped':0},'final_safety_case':{'passed':1,'failed':0},'typecheck':'passed','diff_check':'passed','micro_final':'red','http_requests_succeeded':480,'http_write_readbacks_succeeded':160,'independent_agent_review':'not_run_explicit_scope'},
 'cleanup':{**run['cleanup'],'throwaway_source_and_symlink_removed':True,'settings_probe':json.loads((base/'settings.json').read_text())['own_database_absent_after_drop']},
 'public_scan':{'checked_scope':'only implementation files','local_identity_findings':violations},
 'not_run':['actual App','WeChat','real model','40 startup / 60s RSS protocol','full test suite','package / packaged App'],
 'git_mutations':[],
}
manifest=base/'manifest.json'
manifest.write_text(json.dumps(freeze,ensure_ascii=False,indent=2)+'\n');manifest.chmod(0o600)
files=[p for p in sorted(base.rglob('*')) if p.is_file() and p.name not in ['SHA256SUMS','staging-manifest.json']]
entries=[{'path':str(p.relative_to(repo)),'sha256':sha(p),'bytes':p.stat().st_size} for p in files]
staging={'root_exclusive_index':True,'index_add_commit_performed':False,'task_base_commit':freeze['task_base_commit'],'product':freeze['product'],'evidence':entries,'rule':'仅列本任务候选文件；由root选择并提交，不包含root-preflight-summary或其他作者文件。'}
stage=base/'staging-manifest.json';stage.write_text(json.dumps(staging,ensure_ascii=False,indent=2)+'\n');stage.chmod(0o600)
files.append(stage)
checksums=base/'SHA256SUMS';checksums.write_text(''.join(f'{sha(p)}  {p.relative_to(repo)}\n' for p in files));checksums.chmod(0o600)
for entry in entries:assert sha(repo/entry['path'])==entry['sha256']
print(json.dumps({'frozen':True,'product_files':len(product),'evidence_files':len(entries),'staging_manifest_sha256':sha(stage),'manifest_sha256':sha(manifest),'sha256sums_sha256':sha(checksums),'handoff_lines':len((base/'handoff.md').read_text().splitlines()),'status':freeze['status'],'public_findings':len(violations)},ensure_ascii=False))
