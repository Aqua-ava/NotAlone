# 06 根接收验收

固定源码基线 cc263095707f052a669dea89591cf35f67614800；接收时 HEAD 521109f769d803df243386d3c77cd243bf4ffb13 的另一票六文件提交不影响本批 12 路径。candidate-manifest 6ceecfea、patch 17da1528，根逐文件匹配；精确身份、日志和碰撞例外见 accepted-manifest.json。

普通 Skill 管理由 TS 唯一承接，先停止旧 Python 普通管理、等待 drain，再完成私有移交 ACK；官方 profile 下仍保留默认 Python 回复。历史来源 C 使用原 reply_request、owner/contact、事务及业务守卫；不伪造来源，不更改 15 的审核发布责任。

锁定 DSH 0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317。已核官方 skill/src/index.ts:380–422 与 scope/src/index.ts:137–155 的注册、逐轮 scope 和 dispose；保留既有受控 provider，不修改 DSH 核心。原 06 合同审计和最终独立审查保留具体官方链接。

- 根固定基线重建运行原 skill-http 测试，真实官方 profile 自然 RED：ownership.skills 实际 python，期望 typescript；失败内容保留在 base-red-confirmation.log，不把断言放宽为通过。
- 当前主树 `node --test test/skill-http.test.mjs` 最小 1/1；随后 skill-host、skill-http、skill-library、skill-cleanup、reply-generation-guards、reply-skill-runtime、host-http 合计 41/41。
- `python -m unittest tests.unit.server.test_skill_management_control tests.unit.persistence.test_skill_management_handoff tests.unit.persistence.test_skill_management_remote -v`：21/21；完整 TS `tsc --noEmit` exit 0。
- `node --test test/skill-runtime-provider.test.mjs test/skill-port.test.mjs`：14/14，涵盖真实 PG 的旧 proof、政策及来源撤销、资源 digest、官方 registry/scope 隔离、释放和在途读取。
- 独立最终审查：生产 Standards 0、Spec 0；独立真实控制器 stop/drain/activate/close 1/1。其范围不冒充其他迁移任务验收。
- 实际 npm run dev 的原公开 API＋Computer Use 已验导入、正文和同一 v1、停用、重新启用、删除及空历史；菜单正常退出、自有库和目录清理归零。具体合成绑定、计数及测试目录修正在 ../skill-host-app/README.md。

两个实际发现均有原失败再修复：原备份清理错误曾误变 500，现保留 update_backup_cleanup_required/409 并回滚；移交 ACK 尚未返回时原 Python Remote 已合法同步，曾误拒 503，现私有接纳在 drain 后就绪，公开激活仍等完整 ACK，关闭撤销并等待在途。

交付 artifact-manifest ef9b5067 的 34 条中 32 条匹配；natural-red.json/log 被另一个派生会话同路径写入，原清单不改，碰撞内容不作为原冻结 RED 证据。根另行固定基线独立重现 RED；候选 12 源身份和其余原红绿不受影响。不得宣称旧 artifact 全包有效。

数据影响：沿用原目录、103 不可变版本及 owner/contact 身份，无新 schema、重建业务库或重编号；只处理本机合成隔离资料，真实消息读取、微信发送及外部模型调用均 0。本批不签 05 真实质量、15 学习发布、24 完整回退或最终 TS 默认切换；07 仍等待 05。
