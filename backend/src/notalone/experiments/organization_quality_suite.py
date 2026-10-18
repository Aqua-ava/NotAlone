"""显式自有合成suite的operator CLI；不发送模型请求或签发客户端verified。"""

import argparse
import json
from pathlib import Path
import sys

from notalone.application.organization_quality_suite import SyntheticSuiteReader
from notalone.memory.organization_quality_suite_budget import PersistentSuiteBudget, atomic_json


def main(argv=None):
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest='command', required=True)
    create = commands.add_parser('create', help='固定无连接串的operator清单和跨进程额度。')
    create.add_argument('--manifest', type=Path, required=True)
    create.add_argument('--directory', type=Path, required=True)
    read = commands.add_parser('read', help='读取suite身份和持久物理额度，无正文。')
    read.add_argument('--directory', type=Path, required=True)
    for name, help_text in (
            ('summary', '逐源live复验，返回无正文stage、receipt和实际模型身份。'),
            ('export', '显式导出0600合成全文报告，保留全部失败分母。'),
            ('calibrate', '绑定当前合同、不可变清单和全部成员证据的全局标定。')):
        command = commands.add_parser(name, help=help_text)
        command.add_argument('--directory', type=Path, required=True)
        command.add_argument('--contract-id', required=True)
        if name == 'export':
            command.add_argument('--output', type=Path, required=True)
        if name == 'calibrate':
            command.add_argument('--payload', type=Path, required=True)
    args = root.parse_args(argv)
    try:
        if args.command == 'create':
            budget = PersistentSuiteBudget.create(args.directory, json.loads(args.manifest.read_text()))
        else:
            budget = PersistentSuiteBudget.open(args.directory)
        if args.command in {'create', 'read'}:
            snapshot = budget.snapshot()
            result = {key: snapshot[key] for key in ('suite_id', 'manifest_sha256', 'used_attempts', 'remaining_attempts')}
            result.update({'max_http_attempts': snapshot['manifest']['max_http_attempts'],
                           'fixture_count': len(snapshot['manifest']['fixtures'])})
        else:
            reader = SyntheticSuiteReader(args.directory)
            if args.command == 'calibrate':
                reader.calibrate(args.contract_id, json.loads(args.payload.read_text()))
            if args.command == 'export':
                if args.output.exists():
                    raise ValueError('导出路径已存在。')
                report = reader.report(args.contract_id)
                atomic_json(args.output, report)
                result = {'export': str(args.output), 'report_id': report['report_id'],
                          'status': report['organization']['status']}
            else:
                result = reader.resolve(args.contract_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        # 连接异常可能包含operator配置；标准输出与错误不回显连接串或正文。
        print('合成suite操作失败；检查私有清单、源状态、摘要及额度，未重置任何记录。', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
