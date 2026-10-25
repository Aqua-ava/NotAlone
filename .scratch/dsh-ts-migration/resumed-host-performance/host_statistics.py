"""预注册阈值和成对／case 聚类 bootstrap；失败与未知保留。"""
from __future__ import annotations
import math
import statistics
import json
import hashlib

SEED = 102
RESAMPLES = 10000


def quantile(values, probability):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered)-1)*probability
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower]+(ordered[upper]-ordered[lower])*(position-lower)


def mulberry32():
    state = SEED
    while True:
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        value = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
        value ^= ((value + (((value ^ (value >> 7)) * (value | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)
        yield ((value ^ (value >> 14)) & 0xFFFFFFFF) / 4294967296


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def comparison(clusters, old, new, probability, threshold, complete):
    baseline, candidate = quantile(old, probability), quantile(new, probability)
    ratio = candidate / baseline if baseline not in (None, 0) and candidate is not None else None
    interval = None
    difference_interval = None
    # 性能零基线不得套用调用数／费用的 0/0 例外；不能比较时保持未知。
    if complete and clusters and ratio is not None:
        generator = mulberry32()
        ratios, differences = [], []
        for _ in range(RESAMPLES):
            sample = [clusters[int(next(generator)*len(clusters))] for _ in clusters]
            sample_old = [value for c in sample for value in c['old']]
            sample_new = [value for c in sample for value in c['new']]
            previous, current = quantile(sample_old, probability), quantile(sample_new, probability)
            if previous == 0:
                ratios = []
                break
            ratios.append(current / previous)
            differences.append(statistics.mean(sample_new)-statistics.mean(sample_old))
        if ratios:
            interval = [quantile(ratios, .025), quantile(ratios, .975)]
            difference_interval = [quantile(differences, .025), quantile(differences, .975)]
    gate = ('passed' if interval and interval[1] <= threshold else
            'failed' if interval and interval[0] > threshold else 'undetermined')
    return {'old': baseline, 'new': candidate, 'ratio': ratio, 'ci95': interval,
            'paired_mean_difference': statistics.mean(new)-statistics.mean(old) if complete and old and new else None,
            'all_success_mean_difference': statistics.mean(new)-statistics.mean(old) if old and new else None,
            'paired_mean_difference_ci95': difference_interval, 'threshold': threshold, 'gate': gate,
            'old_success_observations': len(old), 'new_success_observations': len(new),
            'unknown_reason': None if interval else '缺失、失败、不完整配对或零基线；保留全部成功观察。'}


def metrics(rows, key, expected_keys, threshold, unit, successful_only=False):
    rows=[row for row in rows if row.get('terminal_status')=='succeeded'] if successful_only else rows
    values = {arm: [row[key] for row in rows if row['arm'] == arm and finite(row.get(key))]
              for arm in ('old', 'new')}
    clusters, complete = [], True
    for pair_key in expected_keys:
        arms = {arm: [row[key] for row in rows if row['arm'] == arm and
                      row['repeat'] == pair_key and finite(row.get(key))] for arm in ('old', 'new')}
        if any(len(arms[arm]) != 1 for arm in arms):
            complete = False
        clusters.append(arms)
    complete &= all(len(values[arm]) == len(expected_keys) for arm in values)
    return {'unit': unit,
            'p50': comparison(clusters, values['old'], values['new'], .5, threshold[0], complete),
            'p95': comparison(clusters, values['old'], values['new'], .95, threshold[1], complete)}


def build_report(run):
    rows = run['startups']
    population = {}
    for arm in ('old', 'new'):
        found = [row for row in rows if row['arm'] == arm]
        population[arm] = {'planned': run['planned_startups']//2, 'observed': len(found),
                           'succeeded': sum(row['terminal_status']=='succeeded' for row in found),
                           'failed': sum(row['terminal_status']=='failed' for row in found),
                           'cancelled':sum(row['terminal_status']=='cancelled' for row in found),
                           'missing': max(0, run['planned_startups']//2-len(found)),
                           'failed_ids': [row['repeat'] for row in found if row['terminal_status']!='succeeded']}
    result = {'protocol_version': 'host-performance-v1', 'protocol_qualified': False,
              'overall': 'undetermined', 'population': population,
              'bootstrap': {'seed': SEED, 'resamples': RESAMPLES,
                            'algorithm': 'mulberry32-v1/percentile-linear-r7',
                            'startup_rss_unit': 'paired-startup', 'http_unit': 'paired-case-cluster'},
              'metrics': {}, 'http': {}, 'unknown_reason': [],
              'physical_model_requests': run.get('physical_model_requests'),
              'electron': run.get('electron', {'status': 'unknown', 'reason': '宿主离线运行，未操作或启动 Electron。'}),
              'os_cold_cache_claimed': False}
    result['evidence']={'binding':run.get('binding'), 'binding_before':run.get('binding_before'),
                        'binding_after':run.get('binding_after'),
                        'run_canonical_sha256':hashlib.sha256(json.dumps(run,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
    for key in ('startup_ms', 'rss_median_kib'):
        result['metrics'][key] = metrics(rows, key, range(20), (1.20,1.20), 'paired-startup')
    case_clusters = {}
    http = run.get('http', [])
    for case in run.get('http_cases', []):
        selected = [row for row in http if row.get('case_id') == case['id'] and not row.get('warmup')]
        case_result = {'planned_per_arm': 30,
                       'population': {arm: {'planned':30,
                                           'observed': sum(row['arm']==arm for row in selected),
                                           'missing':max(0,30-sum(row['arm']==arm for row in selected)),
                                           'failed_ids':[row['repeat'] for row in selected if row['arm']==arm and row['terminal_status']!='succeeded'],
                                           'warmups_observed':sum(row['arm']==arm and row.get('warmup') and row.get('case_id')==case['id'] for row in http),
                                           'failed': sum(row['arm']==arm and row['terminal_status']!='succeeded' for row in selected)}
                                      for arm in ('old','new')}, 'metrics': {}}
        keys = ['server_response_ms', 'client_response_ms']
        if case.get('write'):
            keys += ['persistence_complete_ms', 'durability_observed_ms', 'transaction_ms']
        for key in keys:
            case_result['metrics'][key] = metrics(selected, key, range(30), (1.15,1.25), 'paired-http-repeat',True)
            if key in ('server_response_ms', 'client_response_ms'):
                case_clusters.setdefault(key, []).append({
                    arm:[row[key] for row in selected if row['arm']==arm and finite(row.get(key)) and row.get('terminal_status')=='succeeded']
                    for arm in ('old','new')})
        case_result['queue_ms'] = {'value': None, 'unknown_reason': '确定性 HTTP 未经业务队列；无独立排队 marker，不填 0。'}
        result['http'][case['id']] = case_result
        case_result['failure_observations']=[{key:row.get(key) for key in (
            'arm','repeat','terminal_status','server_response_ms','client_response_ms','persistence_complete_ms',
            'observed_until_failure_ms','timeout_lower_bound_ms','unknown_reason')}
            for row in selected if row.get('terminal_status')!='succeeded']
    for key, clusters in case_clusters.items():
        old, new = ([v for cluster in clusters for v in cluster[arm]] for arm in ('old','new'))
        complete = all(len(c[arm])==30 for c in clusters for arm in ('old','new'))
        result['metrics']['http_'+key] = {'unit':'paired-case-cluster',
            'p50':comparison(clusters,old,new,.5,1.15,complete),
            'p95':comparison(clusters,old,new,.95,1.25,complete)}
    gates = [m[p]['gate'] for key,m in result['metrics'].items() if key!='http_client_response_ms' for p in ('p50','p95')]
    for case in result['http'].values():
        for key, m in case['metrics'].items():
            if key in ('server_response_ms','persistence_complete_ms'):
                gates += [m[p]['gate'] for p in ('p50','p95')]
    hard_fail = population['new']['failed'] > population['old']['failed'] or run.get('physical_model_requests',0) != 0
    hard_fail |= any(case['population']['new']['failed'] > case['population']['old']['failed']
                     for case in result['http'].values())
    hard_fail |= any(not row.get('cleanup',{}).get('verified',False) for row in rows)
    for arm in ('old','new'):
        for row in http:
            if row['arm']==arm and row['terminal_status']!='succeeded':
                result['unknown_reason'].append(f"HTTP {arm}/{row.get('case_id')}/{row.get('repeat')} 失败或未知")
    if not run.get('binding_verified'):
        result['unknown_reason'].append('源、配置、数据快照、权重缓存或运行环境未完成绑定。')
    if run.get('kind') != 'formal':
        result['unknown_reason'].append('当前为短探针／采样器夹具，不满足 20×60 秒及每例 30 次的原协议。')
    if not run.get('http_cases'):
        result['unknown_reason'].append('缺少同工作负载 HTTP 样本。')
    result['observational_only_metrics']=['client_response_ms','durability_observed_ms','transaction_ms','queue_ms']
    new_processes=[p for row in rows if row['arm']=='new' for sample in row.get('rss',[]) for p in sample.get('processes',[])]
    python_retained=any('python' in p['executable'].lower() for p in new_processes)
    result['new_arm_python_observed']=python_retained
    if python_retained:
        result['unknown_reason'].append('新臂仍含 Python 子进程，不能签为最终 TS 臂；所有 RSS 仍照实保留。')
    if run.get('binding',{}).get('new_source_matches_commit') is False:
        result['unknown_reason'].append('冻结的新臂字节不完全匹配所报 commit；不可签为该最终提交。')
    if run.get('kind')=='formal':
        electron=run.get('electron',{})
        if electron.get('status')=='sampled_separately':
            samples=[sample.get('electron_tree_rss_kib') for row in rows for sample in row.get('rss',[])]
            result['electron']['rss_median_kib']=quantile([v for v in samples if finite(v)],.5)
            result['electron']['rss_p95_kib']=quantile([v for v in samples if finite(v)],.95)
            if len(samples)!=2400 or not all(finite(v) for v in samples):
                result['unknown_reason'].append('Electron 单列 RSS 样本缺失。')
        elif electron.get('status')!='verified_absent' or not electron.get('absence_after_verified'):
            result['unknown_reason'].append('Electron 未单列采样或未完成前后缺席核验。')
        if run.get('sampling',{}).get('rss_interval_seconds')!=1:
            result['unknown_reason'].append('RSS 未按每秒一次采集。')
        if any(abs(sample.get('offset_seconds',-100)-index-1)>.5 for row in rows
               for index,sample in enumerate(row.get('rss',[]))):
            result['unknown_reason'].append('RSS 采样偏离对应一秒时间格；保留迟到样本，不补造数据。')
    cache_changed=any(row.get('model_cache_after',{}).get('files') for row in rows)
    if cache_changed:
        result['unknown_reason'].append('隔离权重缓存出现新增文件，不能声明固定空缓存。')
    result['protocol_qualified'] = (run.get('kind')=='formal' and bool(run.get('binding_verified'))
        and len(rows)==40 and all(row['terminal_status']=='succeeded' and len(row.get('rss',[]))==60 for row in rows)
        and bool(run.get('http_cases')) and all(case['population'][arm]['observed']==30 and case['population'][arm]['failed']==0
        and case['population'][arm]['warmups_observed']==10
        for case in result['http'].values() for arm in ('old','new')) and not result['unknown_reason'])
    result['overall'] = ('failed' if hard_fail or 'failed' in gates else
                         'passed' if result['protocol_qualified'] and all(g=='passed' for g in gates) else 'undetermined')
    return result
