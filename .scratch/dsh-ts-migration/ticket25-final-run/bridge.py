"""仅供评估候选使用的严格 stdin 桥；复用唯一问题总账，不创建或退款。"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import stat
import sys
import time

from notalone.problem_budget import (
    ProblemBudget,
    ProblemStopped,
    check_problem_budget,
    reserve_problem_attempt,
)


def bind_budget(value):
    if not isinstance(value, dict) or set(value) != {'ledger', 'round', 'problem_id'}:
        raise ProblemStopped('budget_configuration_required')
    if any(not isinstance(item, str) or not item.strip() for item in value.values()):
        raise ProblemStopped('budget_configuration_required')
    ledger = Path(value['ledger'])
    if not ledger.is_absolute() or ledger.is_symlink() or not ledger.is_file():
        raise ProblemStopped('budget_ledger_invalid')
    # 真实评估材料与账本只能放仓库外；测试运行时通过模块路径明确仓库根。
    root = Path(os.environ['NOTALONE_BUDGET_REPOSITORY']).resolve(strict=True)
    if ledger.resolve(strict=True).is_relative_to(root):
        raise ProblemStopped('budget_ledger_must_be_private')
    if (stat.S_IMODE(ledger.stat().st_mode) != 0o600
            or stat.S_IMODE(ledger.parent.stat().st_mode) != 0o700
            or ledger.stat().st_uid != os.getuid()
            or ledger.parent.stat().st_uid != os.getuid()):
        raise ProblemStopped('budget_ledger_permissions')
    budget = ProblemBudget(ledger)
    snapshot = budget.snapshot()
    if snapshot['problem'] != value['problem_id']:
        raise ProblemStopped('budget_problem_mismatch')
    if (type(snapshot['max_calls']) is not int or not 1 <= snapshot['max_calls'] <= 2**53 - 1
            or type(snapshot['used']) is not int or not 0 <= snapshot['used'] <= snapshot['max_calls']
            or type(snapshot['deadline']) not in (int, float)
            or not math.isfinite(snapshot['deadline']) or snapshot['deadline'] <= 0):
        raise ProblemStopped('budget_ledger_invalid')
    os.environ['NOTALONE_PROBLEM_BUDGET'] = str(ledger)
    os.environ['NOTALONE_PROBLEM_ROUND'] = value['round']
    return budget


def ack_deadline(snapshot, round_id):
    """只读核验授权；额度恰好用尽时仍允许同一活动轮读取 ACK。"""
    now = time.time()
    deadline = snapshot['deadline']
    grants = snapshot['continuations']
    rounds = snapshot['rounds']
    if (type(snapshot['no_improvement_rounds']) is not int or snapshot['no_improvement_rounds'] < 0
            or not isinstance(grants, list) or not isinstance(rounds, list)
            or any(not isinstance(row, (tuple, list)) or len(row) != 2
                   or not isinstance(row[0], str) or not row[0].strip()
                   or row[1] not in (None, 'improved', 'unchanged', 'regressed', 'unknown')
                   for row in rounds)):
        raise ProblemStopped('budget_ack_rejected')
    if (len({row[0] for row in rounds}) != len(rounds)
            or [row[0] for row in rounds if row[1] is None] != [round_id]):
        raise ProblemStopped('budget_ack_rejected')
    previous_id, previous_rounds = 0, 0
    for grant in grants:
        if (not isinstance(grant, dict)
                or set(grant) != {'id', 'reason', 'existing_rounds', 'max_new_rounds', 'authorized_at', 'deadline'}
                or type(grant['id']) is not int or grant['id'] <= previous_id
                or not isinstance(grant['reason'], str) or not grant['reason'].strip()
                or type(grant['existing_rounds']) is not int
                or not previous_rounds <= grant['existing_rounds'] <= len(rounds)
                or type(grant['max_new_rounds']) is not int or not 1 <= grant['max_new_rounds'] <= 3
                or any(type(grant[key]) not in (int, float) or not math.isfinite(grant[key])
                       for key in ('authorized_at', 'deadline'))
                or not 0 < grant['authorized_at'] <= now
                or grant['deadline'] <= grant['authorized_at']):
            raise ProblemStopped('budget_ack_rejected')
        previous_id, previous_rounds = grant['id'], grant['existing_rounds']
    if grants:
        grant = grants[-1]
        deadline = grant['deadline']
        added = len(rounds) - grant['existing_rounds']
        if (not 0 < grant['authorized_at'] <= now < deadline
                or not 1 <= added <= grant['max_new_rounds']
                or round_id not in [row[0] for row in rounds[grant['existing_rounds']:]]):
            raise ProblemStopped('budget_ack_rejected')
    elif now >= deadline or snapshot['no_improvement_rounds'] >= 2:
        raise ProblemStopped('budget_ack_rejected')
    return deadline


def execute(value):
    if (not isinstance(value, dict) or set(value) != {'schema_version', 'action', 'budget'}
            or value['schema_version'] != 'reply-budget-bridge-v1'
            or value['action'] not in ('check', 'reserve', 'ack')):
        raise ProblemStopped('budget_request_invalid')
    budget = bind_budget(value['budget'])
    if value['action'] == 'ack':
        snapshot = budget.snapshot()
        deadline = ack_deadline(snapshot, value['budget']['round'])
    else:
        check_problem_budget()
        if value['action'] == 'reserve':
            reserve_problem_attempt()
        snapshot = budget.snapshot()
        deadline = snapshot['deadline']
    return {'schema_version': 'reply-budget-bridge-v1', 'action': value['action'],
            'reserved': value['action'] == 'reserve', 'used_reservations': snapshot['used'],
            'max_reservations': snapshot['max_calls'], 'deadline': deadline}


def reserve_request(value, request):
    """旧臂公共 httpx transport 在其 super.handle_* 前调用一次。"""
    bind_budget(value)
    check_problem_budget()
    reserve_problem_attempt(request=request)


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ProblemStopped('budget_request_too_large')
        result = execute(json.loads(raw))
    except Exception:
        # 不把本机账本路径、SQL 异常或原始输入写进公开产物。
        print(json.dumps({'schema_version': 'reply-budget-bridge-v1', 'error': 'budget_bridge_rejected'}))
        sys.exit(2)
    print(json.dumps(result))
