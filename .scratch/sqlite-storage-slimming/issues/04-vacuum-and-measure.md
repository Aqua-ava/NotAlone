# 整理与实测

Triage: ready-for-human
State: open
Type: task
Blocked by: 01, 02, 03

按 [spec](../spec.md) 在前三项完成后做收尾整理，并用实测给出真实收益。

## 范围

1. 清理后的 `VACUUM` 触发时机与空间要求（需要约一份库大小的临时空间、会暂时独占库），在删除模块的 `deletion.compact` 之外是否需要单独入口。
2. 用同一份合成数据和同一工作负载，对比修改前后的库文件大小、各大表和索引大小、`quick_check`／`integrity_check` 耗时、后台 `connecting` 到 `connected` 的耗时。
3. 后台连接耗时先分段计时（进程启动、打开库、握手），再确认检查之外还有哪些大头。

## 验收

- 报告前后数据与取舍，明确哪些是实测、哪些仍是估算；结论写入 `## Answer`。
- 不降低任何完整性检查；开发实例以 `pnpm run dev` 复用热更新实例验证。

## Comments
