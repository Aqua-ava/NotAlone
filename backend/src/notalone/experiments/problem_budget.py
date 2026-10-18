"""开发诊断的问题级总账；仅保存计数与证据摘要，不保存聊天。"""
from contextlib import contextmanager
import argparse
import json
import math
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

    def authorize_continuation(self, *, reason, max_new_rounds=3, minutes):
        """仅供取得明确继续授权后调用；追加授权历史，不重置预算或轮次。"""
        if (not isinstance(reason, str) or not reason.strip()
                or type(max_new_rounds) is not int or not 1 <= max_new_rounds <= 3
                or type(minutes) not in (int, float) or not math.isfinite(minutes) or minutes <= 0):
            raise ValueError('继续授权须记录原因、最多三轮及有限的有效期')
        with self.connection() as db:
            if db.execute('SELECT 1 FROM rounds WHERE outcome IS NULL').fetchone():
                raise ProblemStopped('上一轮须先结案，才能记录新的继续授权')
            db.execute('CREATE TABLE IF NOT EXISTS continuations ('
                       'id INTEGER PRIMARY KEY, reason TEXT NOT NULL, existing_rounds INTEGER NOT NULL, '
                       'max_new_rounds INTEGER NOT NULL, authorized_at REAL NOT NULL, deadline REAL NOT NULL)')
            existing = db.execute('SELECT COUNT(*) FROM rounds').fetchone()[0]
            now = time.time()
            db.execute('INSERT INTO continuations(reason,existing_rounds,max_new_rounds,authorized_at,deadline) '
                       'VALUES (?,?,?,?,?)', (reason.strip(), existing, max_new_rounds, now, now + minutes * 60))

    def _continuations(self, db):
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuations'").fetchone():
            return []
        return [dict(zip(('id', 'reason', 'existing_rounds', 'max_new_rounds', 'authorized_at', 'deadline'), row))
                for row in db.execute('SELECT * FROM continuations ORDER BY id')]

    def start(self, round_id, hypothesis):
        if not round_id.strip() or not hypothesis.strip():
            raise ValueError('每轮必须有标识和可证伪假设')
        with self.connection() as db:
            self.check(db, starting=True)
            if db.execute('SELECT 1 FROM rounds WHERE outcome IS NULL').fetchone():
                raise ProblemStopped('上一轮未结案；不得并行或跳过失败')
            db.execute('INSERT INTO rounds VALUES (?, ?, NULL, NULL)', (round_id, hypothesis))

    def check(self, db, *, starting=False):
        _, limit, deadline, used, streak = db.execute('SELECT * FROM budget').fetchone()
        grants = self._continuations(db)
        if used >= limit:
            raise ProblemStopped('累计调用预算耗尽')
        if grants:
            grant = grants[-1]
            added = db.execute('SELECT COUNT(*) FROM rounds').fetchone()[0] - grant['existing_rounds']
            if time.time() >= grant['deadline']:
                raise ProblemStopped('继续授权已过期')
            if added > grant['max_new_rounds'] or starting and added >= grant['max_new_rounds']:
                raise ProblemStopped('继续授权的新增轮次已用尽')
        elif time.time() >= deadline or streak >= 2:
            raise ProblemStopped('期限已到或连续两轮无改善')

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
            return dict(zip(('problem', 'max_calls', 'deadline', 'used', 'no_improvement_rounds'), row), rounds=rounds,
                        continuations=self._continuations(db))


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
    continuation = sub.add_parser('authorize-continuation')
    continuation.add_argument('--reason', required=True)
    continuation.add_argument('--max-new-rounds', type=int, choices=(1, 2, 3), default=3)
    continuation.add_argument('--minutes', type=int, required=True)
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
    elif args.action == 'authorize-continuation':
        budget.authorize_continuation(reason=args.reason, max_new_rounds=args.max_new_rounds, minutes=args.minutes)
    elif args.action == 'start':
        budget.start(args.round, args.hypothesis)
    elif args.action == 'finish':
        budget.finish(args.round, args.outcome, args.evidence)
    print(json.dumps(budget.snapshot(), ensure_ascii=False))


if __name__ == '__main__':
    main()
