# Standards 独立审查（冻结原候选）

范围：B5-01 四个 scratch 候选、B5-02/03 三个新增 test/helper 及证据打包记录；base `8dc8623d`／tree `00aa5b61`，尚未 apply。规范为 AGENTS、workflow、engineering、领域必要段及 code-review 的全部 12 项 Fowler 启发式；仓库未找到其他 CODING_STANDARDS／CONTRIBUTING。仅静态阅读、SHA、权限与文件存在性；没有项目测试、PG、HTTP、SDK、模型、App、微信、安装或 Git 写入。

1. **[P2，规范缺口] 异常退出会跳过后续自有资源清理。** `reply-arbitration-handover-acceptance/candidate/reply-arbitration-handover.test.mjs:49`、`:71` 在 `await stop(host)` 后才关闭 provider／执行 `f.close()`；`:27` 的 7 秒强退断言会抛错，导致后续步骤全部跳过。`:49` 的 worker 退出等待也无上界。触发后可遗留自有 SSE、临时库和目录，违反 `docs/agents/engineering.md:46` 的自有进程／资源收尾规则。应逐项有界收尾并保留异常；确认全部自有 host／worker／Legacy 已退出，才释放自有 fixture。若退出未证实，可关闭自有 SSE、结束测试持有的 PG client并记录失败，保留库、目录及证据；不要求 FORCE drop、吞异常或终止未知 PID。当前成功轮 cleanup 证明不受此失败路径发现否定。

2. **[P3，证据字段缺口] 目录不存在字段实际检查子文件。** `reply-arbitration-handover-acceptance/package-evidence.py:45` 的 `fixture_paths[].path` 指向 fixture 根，`absent` 却只检查 `statePath`；仅删除 state.json 就能误报目录不存在。按 `AGENTS.md:29` 的运行证据规则，应检查所声明的根路径。原 `priority-cleanup.json`／`handover-cleanup.json` 另有正确的 `fixtureGone=true`，故本项不推断当前轮目录残留。

SHA：B501 manifest `68e1bb26366f0c44dbe277046210fb418c846d1bb6c9529e952cb36849b3cdd6`；B50203 manifest `c39fc95410e852a525078938ff11a0a0d11f8990ddc5feb1f5a1b916c6917958`；patch `236abb6cd55418867b04694fa782a883ffc31e7fac6d4ce434b9efd9c6d34774`。完整输入及核验见相邻 JSON。

其余检查：官方 0.2.1-rc.2／687f282 六份源码 SHA、候选与 patch 字节、148 份依赖及 8 份 raw/public 双 SHA 均匹配；官方归档无 .git，commit 关联沿既有锁证据。网络门禁／dummy key／隔离 env 未见新增绕过；unknown 未冒称 HTTP，累计 24–25 如实保留。当前 root interactive 来源证据只绑定新 UUID。Fowler 启发式新增可操作 finding 0。05/25 原边界保持，不签 App、整05、质量费用性能或切换；后续 v2 另审。
