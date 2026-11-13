# 最终工程验证命令与安全元数据

- 记录时间：2026-11-11T16:37:03+00:00
- 仓库：/Users/local-user/.codex/worktrees/image-input-reliability/NotAlone。
- 最初只读复核轮仅运行公开历史扫描和diff格式检查；下列追加项目为实现Agent之后已实际执行的工程验证。本次在真实L3调用期间只核现有日志，不重跑测试或保存生产源码。
- 4份TEMP为主Agent有意使用的验收hook，本轮未保存生产源码、未评价为“未还原缺陷”，也未操作模型、用户库或桌面。
- 本文件只保存命令、测试数量与元数据日志位置；无聊天、图片、调用正文、凭据或回环token。

## 本轮实际运行

在仓库根执行：

```sh
node scripts/check_public_history.mjs --ref HEAD --working-tree
git diff --check
```

依据：docs/agents/engineering.md:74。使用仓库现有扫描器，未新增或缩小扫描规则。

- 公开历史扫描退出0，stderr为0字节，locations为0；元数据：

```json
{
  "commit": "34a002051f5b68198135924e182284e9e8889da3",
  "historicalBlobs": 26035,
  "historicalCommits": 3526,
  "currentFiles": 2057,
  "issues": 0
}
```

- git diff --check退出0，输出0字节。
- 本轮扫描元数据：/tmp/notalone-review-publichistory.json；格式检查输出：/tmp/notalone-review-diff-check.log。
- 此次覆盖HEAD完整可达历史与当前工作区；没有执行远端操作，不等于对其他分支或未来新增提交背书。

## 已保留的具体执行入口

以下cwd为仓库内backend-ts；这些检查此前已执行，本轮不重跑。结果来自既有Answer或仅抽取计数的日志。

| 命令 | 已记录结果 | 证据 |
| --- | --- | --- |
| `node --test test/model-image-normalization.test.mjs test/model-input-budget.test.mjs` | 初版13/13；后续边界继续由下行覆盖 | issue02 Answer |
| `node --test test/model-image-normalization.test.mjs` | 补小图边界后8/8 | issue02 Answer |
| `node --test test/sqlite-image-recovery-resume.test.mjs` | 2/2；旧c6f源码两例已分别实证red | /tmp/notalone-image-resume-review.log |
| `node --test test/sqlite-memory-run-retirement.test.mjs` | 13/13，含本人反馈失配与未知保护 | /tmp/notalone-owner-retirement-green.log |
| `node --test test/sqlite-memory-unified-runtime.test.mjs` | 2/2，manual持久登记、不自动claim，正式start/wake仍可领取 | /tmp/notalone-runtime-manual-green.log |
| `node --test test/sqlite-memory-late-image-admission.test.mjs` | 1/1 | issue06 Answer |
| `pnpm run typecheck` | tsc --noEmit通过；无TypeScript错误 | /tmp/notalone-runtime-manual-typecheck.log、/tmp/notalone-image-later-typecheck.log、/tmp/notalone-adjudication-source-typecheck.log |

## 其他已记录组合与复现入口

下列原组合命令未全部保留；命令是明确可复现入口，不冒充原执行字符串。已有组合结果保持原统计单位，不相加成“独立测试总量”。

| 可复现入口（cwd=backend-ts） | 已记录组合结果与元数据日志 |
| --- | --- |
| `node --test test/sqlite-later-schedule-release-growth.test.mjs test/sqlite-memory-run-retirement.test.mjs` | 增长2+退休13共15/15；/tmp/notalone-image-later-performance-final.log |
| `node --test test/sqlite-memory-image-lifecycle.test.mjs` | lifecycle包含原有图片/记忆/删除测试及新增3项L2/L3来源冻结、摘要复验、半轮拒绝；相关五文件组合49/49（/tmp/notalone-image-later-regression.log）及半轮定点1/1（/tmp/notalone-image-later-no-half-run.log）；不把50当作此单文件数量 |
| `node --test test/sqlite-reply-background-concurrency-profile.test.mjs` | 此文件现有1项；JPEG像素与原图来源相关组合8/8，/tmp/notalone-profile-normalized-green.log；不把8当作此单文件数量 |
| `node --test test/sqlite-adjudication-source-growth.test.mjs` | 提交34a002051含合成增长/跨动作撤销测试；本清单最初只读审查未重跑，后续结果以实现Agent明确日志为准 |

## 最近追加的实际工程验证

当前HEAD为7d3ab2227，合并main930仅带入2个测试/benchmark文件，不包含主仓3项其他会话WIP。下列测试由实现Agent实际执行，本次仅复核现有日志；不在当前真实L3在途时重跑。

- fa5347005 文档动作内来源资格缓存：`pnpm run typecheck`通过（/tmp/notalone-document-source-typecheck.log）；六文件组合45/45（/tmp/notalone-document-source-regression.log）。实际命令为`node --test test/sqlite-document-source-growth.test.mjs test/sqlite-memory-documents-schedule.test.mjs test/sqlite-memory-documents-unknown.test.mjs test/sqlite-memory-documents-requalification.test.mjs test/sqlite-image-diagnostic-deletion.test.mjs test/sqlite-document-knowledge-scaling.test.mjs`，exit0、45pass、0skip、12.866s。
- fa5347005性能计量限定：同一只读副本的claimScene首写前来源核验到first write boundary为12003→1771ms，sourceSQL4226→267、该段来源核验耗时10898→879ms。这些不是完整claimScene、整份文档或模型阶段耗时；不能据此宣称完整阶段加速倍数。
- 4498fc52b 指定实际图片JPEG摘要条件断连：`node --test --test-concurrency=1 test/sqlite-image-conditional-http.test.mjs test/model-image-transport-receipt.test.mjs` 22/22（/tmp/notalone-image-conditional-http-regression.log）。新集成仅用本轮127.0.0.1合成供应商，4→2→1 primary依次断连、degraded及健康兄弟成功，6个不同HTTP请求各自独立结算；没有真实模型或用户库操作。
- a25dc2a8c L3矛盾引用exact2合同：新增8项及既有L3 workspace直接相关项共19项通过，`pnpm run typecheck`通过（/tmp/notalone-l3-profile-contract-typecheck.log）。/tmp/notalone-l3-profile-contract-regression.log组合总22项、21通过、1失败；不能把该组合写成全绿。实际命令为`node --test test/l3-profile-contradiction-contract.test.mjs test/l3-profile-workspace.test.mjs test/sqlite-memory-profile.test.mjs test/sqlite-memory-auto-profile.test.mjs`，exit1；前两文件8+11=19项全绿，未单独运行19项命令；另外2个profile正常入口通过，unknown shutdown一项失败并另行复现基线。

## 已复现且不属于上述整改回归的4项失败

- sqlite-memory-adjudication-evidence中“关系核验仅引用新来源不得发布更新”“关系核验仅引用旧来源不得发布更新”“add声称补充关系时仍待确认”共3项reason旧断言失败。frozen基线/tmp/notalone-adjudication-evidence-baseline.log与合并main930后的/tmp/notalone-adjudication-evidence-after-main.log均3失败，行为保持不变。
- sqlite-memory-profile的“unknown保持可读和幂等，暂停后关闭排空另一联系人许可等待”1项正常关闭有界排空失败。frozen基线/tmp/notalone-profile-unknown-shutdown-baseline.log与合并后的/tmp/notalone-profile-unknown-shutdown-after-main.log均1失败；独立运行同样复现，不能记为新L3合同修复导致的回归。
- 不扩修上述外部基线问题，不因此宣称全suite通过。它们与本任务真实L3最终业务结果分别报告。

## 回归证据的限定

- /tmp/notalone-image-final-controls.log：47项、47通过、0失败，包含供应商认证失败应暂停且不重复发送的回归。
- /tmp/notalone-image-final-eligibility.log：7项、7通过、0失败。
- /tmp/notalone-image-desktop-merged-final.log：40项、40通过、0失败；这是自动测试，不替代Computer Use验收。
- 旧/tmp/notalone-image-required-final.log实际为79项、78通过、1失败，不能写作全绿；失败位置test/sqlite-memory-extraction.test.mjs:75。后续/tmp/notalone-image-auth-final.log定点1/1及上述controls47/47均覆盖该认证失败回归并通过。原失败日志保持不改。
- 真实14图、L2/L3、逐次模型账本、总开关、Computer Use及TEMP最终还原由主Agent以实际证据另行汇报，本文件不覆盖或推断正在进行的阶段6结果。

## 最终集成后实际检查（由主Agent执行）

- 最终源码/集成HEAD7d3ab2227；main已FF，原3项WIP的SHA完全保留，4TEMP逐项对HEAD还原、CAS clean；工作树tracked clean，main仅原3WIP。
- backend与desktop各执行`pnpm run typecheck`，均exit0；最终`node scripts/check_public_history.mjs --ref HEAD --working-tree`为3532 commits、26047 blobs、2061当前files、issues0；`git diff --check`退出0。本次仅补录这些已执行结果，不重跑或修改扫描范围。
- main普通`pnpm run dev`恢复，无acceptance/budget/manual/UI临时环境；HTTP和Computer Use均总开关关闭，CUA已完成completion_summary，本次不再操作桌面。
- 真实L1/L2与重试UI部分通过，L3gen6仍document_profile_unverified（16核验15supported/1unsupported inference）；3calls均succeeded/settled、effects释放，guard不放宽。最终新增34samplecalls均succeeded/settled、foreign/unproven0/sampleunknown0/other4不变、auto0。账本46used/parent96/执行cap46/extra3尽，无active round；不得写整体阶段6或L3通过。
- .env工作树软链已删/main.env未改，tools/4sourcebackup/worktree.dev/app清理，私有临时目录仅600权限budget.sqlite，无图片/用户DBcopy。
