# 代码加固任务交接（2026-10-22）

## 状态
16/16 tickets 已实现、验证并本地提交（20 个提交，未 push / 未打包）。所有 ticket `State: resolved`，每个提交含中文正文与验证结果。

## 提交映射
| ticket | commit | 内容 |
|---|---|---|
| 01 | 8278cdf9 | 后端未预期异常单点日志（method/path/异常栈，正文脱敏） |
| 02 | 0883b7c9 | SyncHost health：开关/循环失败码 + `/api/sync/status` health 字段 |
| 03 | c55b715b | 导入 `processing_deferred` + runtime `degraded` + task_host 装配 warning |
| 04 | d8979200 | 回复依据读取失败标记 + ContextReceipt 字段（快照 revision 14→15） |
| 05 | 17711937 | 桌面首帧读取失败可见 + 重试 |
| 06 | 731b4837 | 异步准备 202 白名单、取消/异常必发 DELETE |
| 07 | 491f2be2 | 桌面契约单一来源（4096 上限、失败码/原因映射） |
| 08 | fe0e40b2 | Skill 读路径只读化 + 每轮显式同步入口 |
| 09 | ee282510 | Skill 清理失败可观测/可重试 + skill_file_health |
| 10 | c6445b25 | Skill FS 错误区分与路径防御 |
| 11 | dc5cd179 | 记忆读取批量化 + schema 探针正向缓存 |
| 12 | d28f43ea | 三份上下文校验收敛为 `reply/context_validation.py` |
| 13 | 8e53c939 | confirm 事务合并 `persistence/memory_confirm.py` |
| 14 | 6d57812d | 安全死代码删除（REVIEW_TOOL、5 个桌面死组件/导出 + 测试） |
| 15 | c84e5e2f | 记忆页接线版本历史/撤销自动更新/关系概览 |
| 16 | b32fc0e2 | 维度门回退只关白名单（新 ADR-097，README/ADR-036/台账同步） |
| 审查修复 | 52276df6、57074c47、88b61cf5、47af64fe | 空行、日志脱敏、健康身份、上限常量统一 |

## 第二轮复核修复（Standards/Spec 独立审查后）
- 57074c47 / 88b61cf5 / 47af64fe / 52276df6：日志脱敏、Skill 健康身份、字符上限常量、空行（第一批）。
- 第二批：回复回执读取失败字段进入 HTTP、导入延后区分「已入队/未入队」、`/api/runtime/status` 暴露 `skill_files`；维度回退不再影响 `expected_dimension_evidence`/owner 分支/correction 例外；探索与审核端口接入每轮同步、旧库迁移失败后续轮次重试；桌面字符上限统一按码点计数并补边界测试、记忆页补充投影失败不再拖垮主列表、`OwnerLayeredMemoryPanel` 首帧错误可见。
- 遗留项见 `review-followups.md`；真实 App/微信验收仍未执行。

## 验证
- 后端单测：`python -m unittest discover -s tests/unit -t .` 2487 条，14 条既有基线失败（memory_extraction merge_batch/upgrade_ports + experiments pgvector，`git archive HEAD` 基线复现非本轮引入）；另有 1 条 front_sync 时序用例仅全量并发下偶发，单跑 3/3 通过。
- 关键集成：skill 目录/生命周期/清理健康/FS 防御/port/reply_store 67 条 OK；memory 批量化/confirm 一致性/skill 读路径/reply evidence 51 条 OK（隔离 `notalone_test` 库）。
- 桌面：typecheck 通过；`npm test` 983 项 982 通过 1 跳过 0 失败；`test:inventory` 通过。
- 公开历史检查：`node scripts/check_public_history.mjs --ref HEAD --working-tree` 0 issues；`git diff --check` 干净。

## 未做 / 风险
- 未执行真实 App/微信验收（未跑 `npm run dev`）：UI 接线、首帧重试、同步/导入新状态字段的观感未实机验证。
- 新增后台状态（sync health、import degraded、report 读取失败标记、skill_file_health）尚未在桌面或 HTTP 状态页展示；app.py 投影/桌面展示为后续项。
- 未做的 C 项：`app.py` 路由表化、`session.ts` 拆分、评测/实验包迁移、仓库大文件清理、CI/测试 runner 门禁。
- 代码审查（Standards）遗留低优先级项：`_timed_memories`/`_timed_rows` 重复、批量分组骨架重复、initial-read 站点仍各写包装、commit 正文含字面 `\n` 的 3 个历史提交（不回写历史）。
- 准备快照 revision 14→15：升级后旧固定准备快照会 fail closed 要求重新准备，属既定约定。
