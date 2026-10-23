# 06 管理模块验证（进行中）

日期：2026-10-24。业务基线`3c168296e9e8edaa43b8b323ff693e790e709069`；基础宿主采用04完成后代码。尚未公开宿主/App验收，不作为完整迁移签收。

## DSH依据

固定`0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`。主会话恢复的官方archive SHA256为`157903b22c2881d3678d846755afe957a48df834e747deda805a1195ce25a146`。本票实际核对本地官方`packages/skill/skill/package.json`版本，`src/index.ts:247-273`的list/get及signal合同、`:390`注册/失效生命周期，`snapshots/session/skill-load/snapshot.yml`的authored/headless示例；文档`docs/subsystems/skills.md`说明registry/provider/consumer分离。

管理模块不直接调用DSH，负责原PG/不可变文件业务状态；官方registry由薄provider接入，不能用filesystem默认roots或通用consumer替代零或一个冻结版本/路径授权。运行实际测试另见runtime-evidence；示例本身不构成业务验收。

## 实际命令及结果

固定Node：`$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`；测试只使用主会话创建的隔离Unix PG及随机`_test`库。

- 管理首例先因模块不存在RED；实现后导入/列表/预览GREEN。
- 清理失败用例先发现错误地返回删除成功RED；改为资格提交后检查可重试队列，GREEN。
- `node --test backend-ts/test/skill-library.test.mjs`最近完整6/6；随后追加过期工作副本/文件健康测试单项1/1。
- `node --test backend-ts/test/skill-*.test.mjs`最新合计59/59通过，含8项管理、文件、来源proof、官方registry/scope、运行、删除闭包。
- 整树typecheck曾通过；并行票未完成代码引起的临时错误及108迁移门禁切换均另行区分，没有改共享文件或放宽门禁。

管理覆盖原identity、目录发现/修改/坏包、未变不重复版本、停用保留、历史回滚、导出、删除不复活、清理失败重试、跨owner与取消、托管备份依赖缺失拒绝、过期工作任务不覆盖当前版本与健康状态。

## 已发现并修复的缺口

- SQL发布失败的孤立快照及无待处理工作任务的暂存通过旧语义入队，再由提交后的清理消费；保留合法历史。
- 工作副本处理先丢弃过期/删除任务，单任务文件失败记录固定码并继续其他任务。
- 已配置托管目录时缺备份核验依赖拒绝删除；不会默认跳过生产备份。
- 预览/版本读取改用HostStorage只读repeatable-read，不触发目录同步或文件写入。

## 尚未签收

05讨论C来源核验回调、05回复删除递归回调与09托管备份模块的实际装配；停止旧内部目录写入口/排空与唯一责任方移交；官方profile公开HTTP及实际npm run dev Computer Use；规范/规格独立审查收敛；本票本地提交及public-history检查。

未调用真实模型，未读取真实.env/凭据/私人Skill/聊天/业务库；未启动App、微信、打包、push或PR；未add/commit。测试库与文件由fixture清理，合成PG cluster由主会话管理。
