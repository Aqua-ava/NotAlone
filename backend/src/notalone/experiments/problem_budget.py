"""开发诊断的问题级总账；仅保存计数与证据摘要，不保存聊天。"""
from contextlib import contextmanager
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time


class ProblemStopped(RuntimeError):
    pass


class ProblemBudget:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def connection(self):
        if not self.path.is_file() or self.path.is_symlink():
            raise ProblemStopped('问题总账不存在或不是普通文件')
        db = sqlite3.connect(f'file:{self.path}?mode=rw', uri=True)
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        finally:
            db.close()

    def create(self, problem, limit, minutes):
        if not problem.strip() or limit < 1 or minutes < 1:
            raise ValueError('问题、次数和时间上限必须有效')
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with self.connection() as db:
            db.execute('CREATE TABLE budget (problem TEXT, max_calls INTEGER, deadline REAL, used INTEGER, streak INTEGER)')
            db.execute('INSERT INTO budget VALUES (?, ?, ?, 0, 0)', (problem, limit, time.time() + minutes * 60))
            db.execute('CREATE TABLE rounds (id TEXT PRIMARY KEY, hypothesis TEXT, evidence TEXT, outcome TEXT)')

    def start(self, round_id, hypothesis):
        if not round_id.strip() or not hypothesis.strip():
            raise ValueError('每轮必须有标识和可证伪假设')
        with self.connection() as db:
            self.check(db)
            if db.execute('SELECT 1 FROM rounds WHERE outcome IS NULL').fetchone():
                raise ProblemStopped('上一轮未结案；不得并行或跳过失败')
            db.execute('INSERT INTO rounds VALUES (?, ?, NULL, NULL)', (round_id, hypothesis))

    def check(self, db):
        _, limit, deadline, used, streak = db.execute('SELECT * FROM budget').fetchone()
        if used >= limit or time.time() >= deadline or streak >= 2:
            raise ProblemStopped('累计预算耗尽、期限已到或连续两轮无改善')

    def reserve(self, round_id):
        with self.connection() as db:
            self.check(db)
            if not db.execute('SELECT 1 FROM rounds WHERE id=? AND outcome IS NULL', (round_id,)).fetchone():
                raise ProblemStopped('该轮不存在或已经结案')
            db.execute('UPDATE budget SET used=used+1')

    def finish(self, round_id, outcome, evidence):
        if outcome not in ('improved', 'unchanged', 'regressed', 'unknown') or not evidence.strip():
            raise ValueError('结案须有结果及本机证据路径或摘要')
        with self.connection() as db:
            row = db.execute('SELECT outcome FROM rounds WHERE id=?', (round_id,)).fetchone()
            if row != (None,):
                raise ProblemStopped('该轮不存在或已结案，不能覆盖结果')
            db.execute('UPDATE rounds SET outcome=?, evidence=? WHERE id=?', (outcome, evidence, round_id))
            db.execute('UPDATE budget SET streak=' + ('0' if outcome == 'improved' else 'streak+1'))

    def snapshot(self):
        with self.connection() as db:
            row = db.execute('SELECT * FROM budget').fetchone()
            rounds = db.execute('SELECT id, outcome FROM rounds').fetchall()
            return dict(zip(('problem', 'max_calls', 'deadline', 'used', 'no_improvement_rounds'), row), rounds=rounds)


def reserve_problem_attempt():
    """两类已有评测发送边界调用；未绑定的历史工具保持原合同。"""
    path = os.environ.get('NOTALONE_PROBLEM_BUDGET')
    round_id = os.environ.get('NOTALONE_PROBLEM_ROUND')
    if path is None and round_id is None:
        return
    if not path or not round_id:
        raise ProblemStopped('问题总账与轮次必须同时绑定')
    ProblemBudget(path).reserve(round_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ledger', required=True)
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('create')
    create.add_argument('--problem', required=True)
    create.add_argument('--calls', type=int, required=True)
    create.add_argument('--minutes', type=int, required=True)
    start = sub.add_parser('start')
    start.add_argument('--round', required=True)
    start.add_argument('--hypothesis', required=True)
    finish = sub.add_parser('finish')
    finish.add_argument('--round', required=True)
    finish.add_argument('--outcome', choices=('improved', 'unchanged', 'regressed', 'unknown'), required=True)
    finish.add_argument('--evidence', required=True)
    sub.add_parser('status')
    args = parser.parse_args()
    budget = ProblemBudget(args.ledger)
    if args.action == 'create':
        budget.create(args.problem, args.calls, args.minutes)
    elif args.action == 'start':
        budget.start(args.round, args.hypothesis)
    elif args.action == 'finish':
        budget.finish(args.round, args.outcome, args.evidence)
    print(json.dumps(budget.snapshot(), ensure_ascii=False))


if __name__ == '__main__':
    main()
