"""整理质量公开工具：显式自有隔离合成服务、人工审阅、持久有限候选评测。"""

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import UUID


def _request(args, path, payload=None):
    token = os.environ.get(args.token_env)
    if not token:
        raise ValueError('须通过指定环境变量提供当前合成服务token。')
    request = Request(args.backend_base_url.rstrip('/') + path,
        data=json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        response = urlopen(request, timeout=210)
    except HTTPError as error:
        response = error
    with response:
        result = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(f'公开质量命令失败：HTTP {response.status}，{result.get("error", "unknown")}。')
        return result


def _json_file(path):
    return json.loads(Path(path).read_text())


def _save(path, value):
    target = Path(path)
    if target.exists():
        raise ValueError('输出文件已存在，请使用新路径保留原始证据。')
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def _serve(args):
    import psycopg
    from notalone.persistence.layered_memory import PostgresLayeredMemoryStore
    from notalone.persistence.organization_quality import PostgresOrganizationQualityStore
    from notalone.memory.layered import OrganizationBudget
    from notalone.memory.organization_quality import OrganizationQualityService, OrganizationQualityContract
    from notalone.memory.organization_sdk import build_deepseek_organization_evaluation
    from notalone.application.layered_memory_service import LayeredMemoryService
    from notalone.server.app import BackendServer, create_app
    database_url = os.environ.get(args.database_url_env)
    token = os.environ.get(args.token_env)
    if not database_url or not token:
        raise ValueError('须显式提供自有隔离库与服务token环境变量。')
    with psycopg.connect(database_url) as connection:
        if connection.info.dbname != args.expected_database or not connection.info.dbname.endswith('_test'):
            raise ValueError('实际候选评测只允许明确归属的隔离合成库。')
        if not connection.execute("SELECT to_regclass('public.organization_quality_run')").fetchone()[0]:
            raise ValueError('自有隔离库尚未应用整理质量迁移。')
    store = PostgresLayeredMemoryStore(database_url)
    budget = OrganizationBudget(max_model_calls=4, max_characters=args.max_characters,
        max_memories=args.max_memories, max_scenarios=args.max_scenarios,
        max_paragraphs=args.max_paragraphs, max_profile_entries=args.max_profile_entries)
    from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget
    if not args.prepare_only and (not args.suite_directory or not args.suite_source_ref):
        raise ValueError('实际候选服务须绑定同一不可重置suite及明确source_ref。')
    quota = PersistentSuiteBudget.open(Path(args.suite_directory)) if args.suite_directory else None
    runtime = (None if args.prepare_only else build_deepseek_organization_evaluation(budget=budget,
        suite_budget=quota, source_ref=args.suite_source_ref))
    candidate = runtime.ports[0].model.model_name if runtime is not None else 'deepseek-flash'
    contract = OrganizationQualityContract(provider='deepseek', request_model=candidate,
        verifier_provider='deepseek', verifier_model=candidate, budget=budget)
    quality = OrganizationQualityService(PostgresOrganizationQualityStore(store), organization_contract=contract,
        evaluation_runtime=runtime)
    service = LayeredMemoryService(store, quality=quality, budget=budget)
    server = BackendServer(create_app(database_url=database_url, owner_id=UUID(args.owner_id),
        token=token, layered_memory=service), host='127.0.0.1', port=args.port)
    try:
        host, port = server.start()
        print(json.dumps({'event': 'organization_quality_ready', 'backend_base_url': f'http://{host}:{port}',
            'contract_id': contract.identity, 'data_kind': 'fixed_synthetic', 'automatic_use_allowed': False}), flush=True)
        server.serve_forever()
    finally:
        server.shutdown()
        if runtime is not None:
            runtime.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='command', required=True)
    serve = subparsers.add_parser('serve', help='启动显式自有隔离合成评测服务；按工程规则放后台')
    serve.add_argument('--database-url-env', required=True)
    serve.add_argument('--expected-database', required=True)
    serve.add_argument('--owner-id', required=True)
    serve.add_argument('--token-env', required=True)
    serve.add_argument('--port', type=int, default=0)
    serve.add_argument('--prepare-only', action='store_true', help='只公开冻结/标注/建run，不读模型凭据或外连')
    serve.add_argument('--suite-directory')
    serve.add_argument('--suite-source-ref')
    contract_parser = subparsers.add_parser('contract', help='离线给出明确候选与预算合同，不读取凭据')
    contract_parser.add_argument('--output', required=True)
    for name, value in [('max-characters', 8000), ('max-memories', 12), ('max-scenarios', 4), ('max-paragraphs', 8), ('max-profile-entries', 4)]:
        serve.add_argument('--' + name, type=int, default=value)
        contract_parser.add_argument('--' + name, type=int, default=value)
    for name in ('create', 'execute', 'report', 'annotate', 'review', 'calibrate'):
        command = subparsers.add_parser(name)
        command.add_argument('--backend-base-url', required=True)
        command.add_argument('--token-env', required=True)
        command.add_argument('--output', required=True)
        if name in {'create', 'annotate', 'review', 'calibrate'}:
            command.add_argument('--input', required=True, help='具体公开请求JSON，禁止verified直接授予字段')
        if name in {'execute', 'report', 'calibrate'}:
            command.add_argument('--run-id', required=True)
        if name in {'annotate', 'review'}:
            command.add_argument('--case-id', required=True)
        if name == 'execute':
            command.add_argument('--allow-unreviewed-smoke', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'contract':
            from notalone.memory.layered import OrganizationBudget
            from notalone.memory.organization_quality import OrganizationQualityContract
            budget = OrganizationBudget(max_model_calls=4, max_characters=args.max_characters,
                max_memories=args.max_memories, max_scenarios=args.max_scenarios,
                max_paragraphs=args.max_paragraphs, max_profile_entries=args.max_profile_entries)
            contract = OrganizationQualityContract(provider='deepseek', request_model='deepseek-flash',
                verifier_provider='deepseek', verifier_model='deepseek-flash', budget=budget)
            _save(args.output, {'contract_id': contract.identity, 'contract': contract.to_payload(),
                'data_kind': 'fixed_synthetic', 'quality_verified': False})
            print(json.dumps({'output': str(Path(args.output).resolve()), 'contract_id': contract.identity,
                'quality_verified': False}))
            return 0
        if args.command == 'serve':
            _serve(args)
            return 0
        base = '/api/layered-memory/'
        if args.command == 'create':
            result = _request(args, base + 'quality-runs', _json_file(args.input))
        elif args.command in {'annotate', 'review'}:
            action = 'annotations' if args.command == 'annotate' else 'review'
            result = _request(args, base + 'quality-inputs/' + str(UUID(args.case_id)) + '/' + action, _json_file(args.input))
        elif args.command == 'calibrate':
            result = _request(args, base + 'quality-runs/' + str(UUID(args.run_id)) + '/calibration', _json_file(args.input))
        else:
            path = base + 'quality-runs/' + str(UUID(args.run_id))
            result = _request(args, path)
            if args.command == 'execute':
                # 每轮最多一个有界场景；所有阶段、失败、重启共享同一run的持久总额度。
                for _ in range(result['quality_report']['case_count'] + 1):
                    if result['quality_report']['state'] == 'complete':
                        break
                    result = _request(args, path + '/execute', {'allow_unreviewed_smoke': args.allow_unreviewed_smoke})
        _save(args.output, result)
        report = result.get('quality_report')
        print(json.dumps({'output': str(Path(args.output).resolve()), **({
            'report_id': report['report_id'], 'state': report['state'], 'http_attempts_used': report['http_attempts_used'],
            'max_http_attempts': report['max_http_attempts'], 'quality_status': report['organization']['status']} if report else {})}, ensure_ascii=False))
        return 0
    except (ValueError, RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
