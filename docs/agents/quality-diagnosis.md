# 小批诊断与累计预算

适用于记忆提取、L2/L3 整理和回复质量实验；不改变生产门禁或正式质量资格。

## 先确定真实问题

- 在用户指定的单一联系人范围内，先只读 5～10 段已有原文与对应结果，由 Agent 标出具体错误。不得默认跨联系人搜索；联系人名称必须解析到唯一的 owner/contact 身份。
- 真实资料只保存在仓库外私有目录，不进入单元测试、Git 或公共报告。外部模型调用须有明确的数据范围和供应商授权；本机诊断本身不需要外发。
- 原文不插入说明。时间、说话人、来源 ID 单独记录；保存原文和实际模型输入的摘要及差异。合成异常测试单列，不能代替真实使用质量结论。
- 首轮没有观察到错误时报告“本批未发现”，不为获得失败而增加说明或改变原文。

## 每轮只验证一个假设

开始前记录问题 ID、具体失败、唯一改动、预期信号、原失败与正确对照、来源和版本。先定点复现，修复后检查原失败及正确对照，再用未参与调整的样例验收。只有原目标改善且对照不退化才记为 improved；仅运行成功、结构合规或错误定位更细不算质量改善。

复用现有单轮物理预算，额外绑定问题级总账。同一问题的不同 prompt、模型、目录和 run 必须共用一个账本，不得重建重置。账本放仓库外 0700 私有目录，文件为 0600，不存聊天、凭据或联系人姓名。旧实验次数另列，未知不填零；新账本必须注明统计起点，不能冒充历史总数。

### 准备总账管理工具

当前工作树不含旧 Python 后台。总账管理 CLI 保存在历史提交 `23a767330e4af8a024629a00c8740344be564259`；TS provider 消费已有总账，不会创建或结案。以下仅恢复该 CLI 所需的标准库模块到私有临时目录，并用独立 venv 执行；它不启动旧后台，不改变正常产品入口。在仓库根目录的同一 Bash／Zsh 会话中执行：

```bash
set -euo pipefail
umask 077
NOTALONE_BUDGET_TOOLS="$(mktemp -d "${TMPDIR:-/tmp}/notalone-budget-cli.XXXXXX")"
git archive 23a767330e4af8a024629a00c8740344be564259 \
  backend/src/notalone/__init__.py backend/src/notalone/problem_budget.py \
  backend/src/notalone/experiments/__init__.py backend/src/notalone/experiments/problem_budget.py \
  | tar -x -C "$NOTALONE_BUDGET_TOOLS"
python3 -m venv "$NOTALONE_BUDGET_TOOLS/venv"
budget_cli() {
  PYTHONPATH="$NOTALONE_BUDGET_TOOLS/backend/src" \
    "$NOTALONE_BUDGET_TOOLS/venv/bin/python" -m notalone.experiments.problem_budget \
    --ledger "$DIAG_LEDGER" "$@"
}
```

在工具目录之外为 `DIAG_LEDGER` 指定固定绝对路径：直接父目录须属于当前用户且权限为 `0700`，账本须为非软链接的 `0600` 普通文件。新问题首次创建时路径必须不存在；同一问题已有账本时沿用原文件，先用 `budget_cli status` 核对问题、剩余额度、期限及轮次，不能重新创建或清零。统计起点和此前次数另写入同一问题的私有记录。

```bash
# 仅新问题首次创建；将问题 ID、假设和证据替换为本次值。
budget_cli create --problem '问题 ID' --calls 8 --minutes 30
budget_cli start --round r1 --hypothesis '本轮唯一可证伪假设'
export NOTALONE_PROBLEM_BUDGET="$DIAG_LEDGER"
export NOTALONE_PROBLEM_ROUND=r1
```

准备真实资料及单轮配置应在创建账本之前完成。为新一轮填写新轮次并先 `start`；满足下方绑定验证、单轮预算、数据与供应商授权后运行有限评测。评测和独立判断结束后，按实际证据将 `NOTALONE_BUDGET_OUTCOME` 设为 `improved`、`unchanged`、`regressed` 或 `unknown`，将 `NOTALONE_BUDGET_EVIDENCE` 设为本机证据路径或摘要，再结案：

```bash
budget_cli finish --round "$NOTALONE_PROBLEM_ROUND" --outcome "$NOTALONE_BUDGET_OUTCOME" --evidence "$NOTALONE_BUDGET_EVIDENCE"
budget_cli status
```

工具目录可按精确路径清理，问题账本及私有证据保留。

### 绑定和验证发送边界

在实际 DSH 进程安装模型 provider **之前**将两个变量注入该进程的 OS 环境；已运行进程不会因为另一个 shell 的 `export` 或修改 `.env` 自动绑定。按[TS 诊断预算](../../backend-ts/diagnostic-problem-budget.md)核对实际调用路径、绑定和发送前预留，并确认所有本轮外部发送都受同一问题总账约束；不能只凭变量或账本文件存在认定生效，也不要输出完整进程环境。需要重启时遵循工程工作流的桌面开发规则。CLI、账本、实际进程绑定或发送边界任一无法验证时，停止外部实验并报告缺口。

默认小批外部实验上限 8 次请求预留、30 分钟；用户明确另定则在开始前记录。时间从 create 起计，准备数据应在之前完成。截止时间阻止后续发送，不中断在途请求，仍需底层请求超时。请求发送前持久计数，失败、未知响应及预留后异常不退款；它是保守的预留数，不能冒充实际 HTTP 数或账单金额。

当前 TS provider 的普通和 strict 发送路径通过同一总账预留；未绑定时保留正常产品行为，因此这不是全局网络防火墙。使用历史 Python 整理诊断时仍须配置其 `PersistentSuiteBudget` 并核对 transport；无 suite 的旧分支不会经过总账。其他发送路径必须先接入，不能用临时 SDK 调用绕过；一次物理发送只选择一个总账入口，避免叠加计数。离线单元测试不消耗真实问题账本。

## 停止与结案

- 累计请求额度用完、时间到期、连续两轮无改善时，工具拒绝继续预留。unknown 和 regressed 都计入无改善；未结案轮次阻止开启下一轮。
- 达到停止条件后保存证据、解释原因和提出替代路径，不再自动加预算或新建问题编号。需要改变已约定预算或修复方向时，提出具体取舍；不能仅申请“再跑一轮”。
- 每轮由独立 Agent 判断结果，不要求用户逐例验收；需要产品取舍时才询问用户。Agent 审阅不得登记成人工审阅，也不替代原 spec 尚未修改的正式资格条件。
- 独立验收 Agent 不可用时，可继续不依赖该判定的修复与离线验证，保存证据并报告独立验收未完成。等待独立判断的轮次保留未结案，按总账规则不开始下一轮；不得将自查冒充独立审阅或宣称已达到依赖该审阅的正式资格。
- 汇报分别列出工程完成、目标质量是否改善、是否可启用，以及已用/剩余预算、未解决的真实失败。验收通过的单点及时提交，剩余失败如实保留；不以测试数量或审计完整代替质量。
