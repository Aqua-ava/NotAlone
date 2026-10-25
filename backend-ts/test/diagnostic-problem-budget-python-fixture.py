"""仅对随机合成总账做并发互操作，不连接业务库或模型。"""
import json
import sys

from notalone.problem_budget import ProblemBudget, ProblemStopped


budget = ProblemBudget(sys.argv[1])
print('ready', flush=True)
sys.stdin.readline()
reserved = 0
for _ in range(16):
    try:
        budget.reserve(sys.argv[2])
        reserved += 1
    except ProblemStopped:
        break
print(json.dumps({'reserved': reserved}), flush=True)
