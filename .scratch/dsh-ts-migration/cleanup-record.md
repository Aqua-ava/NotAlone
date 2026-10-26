# 迁移工作区清理记录

2026-10-26，按用户要求清理重复源码快照和无用临时文件，保留必要的最终验收记录。清理前的主仓提交为 `48770e9c6c5727c5a81e8996dcdc630d4ad48c2b`。

## 保留入口

- [最终迁移交接](root-current-handoff.md)：当前结果、原生工具边界及未执行项目。
- [最终固定采集](final-acceptance-closeout/capture-summary.json)：96条采集与定量结果；用户取消的盲评和启动／RSS对照仍为未评／未测。
- [最终实际App记录](final-acceptance-closeout/actual-app-r9.json)及[退役后验证](ticket26-retirement-result/verification.json)：生成、保存、重读、退出、原失败和数据一致性。
- [实际App范围与恢复记录](task25-root-app-acceptance/observations.md)：联系人范围、同步、主动停止和恢复。
- [任务25结案](issues/25-integrated-acceptance.md)、[任务26结案](issues/26-retire-python-frameworks.md)，以及规格、范围决定和各任务的最终验收出处。
- `baseline/`、`ticket25-final-run/`、`resumed-nonreply-evaluation/` 和少量 `incremental-sync/` 文件仍被现有测试引用；保留所需脚本、配置和合成夹具。最终记录直接链接的少量探针或补丁也保留，不保留整套源码副本。

## 清理范围

仅清理 `.scratch/dsh-ts-migration/` 内的文件，包括重复的 `base`、`draft`、`frozen`、`reference` 源码树、三个独立临时快照仓库、过期候选补丁、逐轮诊断输出、日志和缓存。

- 移除28,377个文件或链接，其中2,248个原为主仓跟踪文件。
- 清理后保留233个原文件，另新增本记录；目录实际占用从约607 MiB降至约6 MiB。
- 已跟踪的历史产物可从上述清理前提交逐文件恢复。未跟踪文件及独立快照仓库另有仓库外端侧压缩恢复档；恢复档、逐文件哈希和精确清单不纳入Git。

## 验证与数据影响

保留记录逐文件哈希不变。目录外3,735个已跟踪或未跟踪文件及现存原配置哈希不变，包含用户已有的三处测试修改；正式源码、116份SQL、依赖、其他任务目录未改。没有连接、改写或删除用户数据库、原始资料、微信资料或用户目录。

核对现有代码对迁移目录的直接引用和保留脚本的25处静态模块引用；清理没有删除这些依赖。执行Git范围及空白检查，随后按工程规则创建本地提交并检查公开历史。

本次只做文件清理和引用核验，未启动App、调用模型、发送消息、运行产品测试、打包、推送或创建PR；不改变原验收结论，也不恢复用户已取消的评测。
