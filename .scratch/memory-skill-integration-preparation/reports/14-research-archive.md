# 14：语义研究归档与来源核验

日期：2026-10-15。对应[集成票14](../issues/14-semantic-research-archive.md)。本票以固定M2 `08c4d48e719353492f37620f4fb2aabd8710efc6` 为产品基底，只归档固定S `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` 已有的合成研究证据，不运行旧实验。

## 归档入口与身份

三份报告保留原路径及原字节，以保留原报告内的相对引用和历史复算命令：

| 归档报告 | SHA-256 |
| --- | --- |
| [事前分析计划](../../memory-skill-evolution/reports/14-audit-plan.md) | `3b79c1c7e8f3603b5ad2e5b2b636033ce69cb9b24d1d43b129adc7a2dedcafe4` |
| [原实际复算命令](../../memory-skill-evolution/reports/14-audit-command.md) | `a1e594c5aefcd2d0f2f81a100012207e07f5333350b1d0f40b0c39b73afd1409` |
| [完整机器证据](../../memory-skill-evolution/reports/14-historical-audit.json) | `71fbdb2197f5edfdc3409195f494cade8654978d95e222202abcffe12eb4d2b8` |

原研究提交为 `175c945bac11bcc3a52249669ce687f2e147d277`，S内整合提交为 `50766c06fd810e6f61fbf5e78ab6806c12fe999e`。三报告在这两个提交与固定S中分别具有相同Git blob：`1643f58ab6ab6b55d1e585601f232b3ee8d81597`、`a45055457b45449cb607c18fe67cc27d21ccd882`、`acc7441738d17733e6299d5d37539db1b1adf6a3`。该映射由对象内容核验；不是重放原分支，也不把原票resolved状态当作集成票完成。

原票的完整结论和历史18/18记录可用以下固定对象查看；本批不覆盖main中原票或旧planning：

```bash
git show 54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616:.scratch/memory-skill-evolution/issues/14-semantic-retrieval-gap-evaluation.md
```

## 冻结输入和结论

原一手结果为 [native-v3/result.json](../../../experiments/pgvector/runs/native-v3/result.json)，SHA-256由机器证据中的 `raw_result_sha256` 固定。开发集30条，冻结 `tau=0.5767089472239593`；final完整103条，质量组95条，其中85条有联系人gold。机器证据完整保留103条身份；质量组不是全部103条，正例85也不是误注入分母。

| 原final指标 | A词法 | B pgvector |
| --- | ---: | ---: |
| 改写宏Recall@5（60条） | 1.67% | 26.39% |
| 直述宏Recall@5（20条） | 94.17% | 94.17% |
| 质量组无关注入query | 15/95 | 36/95 |
| 质量组错误身份数 | 45 | 81 |
| 完整检索P95 | 16.28 ms | 24.16 ms |

原pgvector方案的召回改善没有抵消误注入增加，故不启用。原[报告](../../../experiments/pgvector/REPORT.md)及[历史修正](../../../experiments/pgvector/review.md)保留。源14的三项廉价修补只是对已公开final入选集合的历史子集分析，没有重新检索、冻结新最终集或取得新完整耗时；gold oracle也只是事后乐观上界。主体、用途及事件相关性判别仍是待独立研究提案，不能写成通过或已实现。

原18/18仅为既有实验适配器及证据合同回归，是源票历史执行成绩；本票没有重跑，也不将它写成语义质量通过。原超时计数仍为未知，0失败不证明超时门通过。合成静态隔离、来源及revision核验不替真实来源删除、并发、真实模型泛化或App/渠道补签。

冻结输入位于 [dataset.json](../../../experiments/hindsight/v2/dataset.json)、[gold.json](../../../experiments/hindsight/v2/gold.json)、[dataset-manifest.json](../../../experiments/hindsight/v2/dataset-manifest.json)，本票核对当前文件和固定S均匹配机器证据的三个SHA-256。原运行9个参与源码摘要按公开证据提交 `53372729959dc013313df1116d076d2c562dcadd` 的原路径核验；不要求当前重构后的模块等同原运行代码。原运行起点 `e015b960` 的公开映射 `6dc1a499` 仍见[提交映射](../../../docs/publication-commit-map.tsv)。

## 生产边界与数据影响

本票没有改产品代码、依赖、迁移、配置或实验结果。[正式回复装配](../../../backend/src/notalone/server/reply_wiring.py)仍使用 `PostgresRetrieval`，[持久化检索](../../../backend/src/notalone/persistence/retrieval.py)仍调用[词法评分](../../../backend/src/notalone/retrieval/ranking.py)；本票没有接入pgvector或启用生产语义补充。此项是仓库静态装配核验，没有读取运行环境或声称已核运行时配置。

[维度放行默认值](../../../backend/src/notalone/memory_extraction/dimensions.py)仍为空；`NOTALONE_MEMORY_DIMENSION_GATE=0` 的显式运维回退边界保持，[放行台账](../../../docs/memory-adoption-dimension-release-ledger.md)不变。[ADR-028](../../../architecture/adr/028-lexical-memory-recall-phase-1.md)、[ADR-036](../../../architecture/adr/036-per-dimension-adoption-release.md)和[ADR-048](../../../architecture/adr/048-memory-skill-evolution-lifecycle.md)均未修改。

本票只增加已在固定S内公开的合成研究文档和必要工程索引，不读取私聊、载荷、仓库外日志、`.env`或凭据；不导入端侧research笔记。数据库、模型和桌面均未占用，S分叉库未接触，未新增运行时产物或删除依赖。

## 本票实际验证

以下Node命令只读Git对象和仓库合成JSON，不导入产品模块，不执行归档中的Python命令，也不重新计算或运行检索实验：

```bash
node <<'JS'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const S = '54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616';
const original = '175c945bac11bcc3a52249669ce687f2e147d277';
const integrated = '50766c06fd810e6f61fbf5e78ab6806c12fe999e';
const prefix = '.scratch/memory-skill-evolution/reports/';
const git = (...args) => execFileSync('git', args);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const name of ['14-audit-plan.md', '14-audit-command.md', '14-historical-audit.json']) {
  const path = prefix + name;
  const frozen = git('show', S + ':' + path);
  for (const ref of [original, integrated]) assert.ok(git('show', ref + ':' + path).equals(frozen));
  assert.ok(fs.readFileSync(path).equals(frozen));
}
git('merge-base', '--is-ancestor', integrated, S);
const audit = JSON.parse(fs.readFileSync(prefix + '14-historical-audit.json'));
const raw = fs.readFileSync('experiments/pgvector/runs/native-v3/result.json');
const result = JSON.parse(raw);
assert.equal(sha(raw), audit.raw_result_sha256);
assert.equal(sha(fs.readFileSync(prefix + '14-audit-plan.md')), audit.analysis_plan_sha256);
for (const [name, digest] of Object.entries(audit.frozen_data_sha256)) {
  const path = 'experiments/hindsight/v2/' + name;
  assert.equal(sha(fs.readFileSync(path)), digest);
  assert.equal(sha(git('show', S + ':' + path)), digest);
}
for (const [path, digest] of Object.entries(result.provenance.participating_module_sha256)) {
  assert.equal(sha(git('show', '53372729959dc013313df1116d076d2c562dcadd:' + path)), digest);
}
for (const [arm, key] of [['A_lexical', 'baseline_summaries'], ['B_vector', 'vector_summaries']]) {
  assert.deepEqual(Object.keys(audit.summaries[arm]).sort(), Object.keys(result[key]).sort());
  for (const [group, fields] of Object.entries(result[key])) {
    assert.deepEqual(Object.keys(audit.summaries[arm][group]).sort(), Object.keys(fields).sort());
    for (const [field, value] of Object.entries(fields)) {
      const actual = audit.summaries[arm][group][field];
      if (typeof value === 'number') assert.ok(Math.abs(actual - value) <= 1e-12);
      else assert.equal(actual, value);
    }
  }
}
assert.equal(audit.per_query.length, 103);
for (const [arm, wrong] of [['A_lexical', 15], ['B_vector', 36]]) {
  const quality = audit.summaries[arm]['final/quality'];
  assert.equal(quality.queries, 95);
  assert.equal(quality.positive_queries, 85);
  assert.equal(quality.irrelevant_injection_queries, wrong);
}
assert.equal(audit.fresh_heldout_validation, false);
assert.equal(audit.new_embedding_calls, 0);
assert.equal(audit.new_database_queries, 0);
assert.equal(audit.timeout.historical_count, null);
assert.equal(audit.posthoc_oracle_feasibility_bound.fresh_validation, false);
console.log('PASS: 三份原报告、三个冻结输入、九个原源码摘要、103/95/85分母及历史A/B汇总一致；未运行实验。');
JS
```

首次核验使用严格浮点全等，遇到A质量组精度 `0.6686274509803922` 与原JSON `0.6686274509803921` 的末位差异而失败；改为原研究已声明的 `1e-12` 容差后全部通过，没有改动任何原始数值。随后运行 `git diff --check` 和本票相对基底的路径范围检查。产品测试、18项实验回归及归档内两段历史复算均未运行。

提交后执行 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree`，仅作公开内容检查，结果在本票Answer记录。独立Standards/Spec审查由主集成调度，审查完成前不代表整批完成。
