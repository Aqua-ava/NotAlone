# TS 未配置控制面根验收

父提交 26acfff4fc6e1ed9edd2dc5bfa8c437fb5fc393d；组合候选 26 路径（15 产品源＋11 测试）。相对该父提交逐项核 35 个选定路径的 base、应用 d3c328d0 组合 patch 后核 candidate；唯一根追加为新 Python 测试 EOF 空行正规化，无行为修改。精确身份和实际验证输入见 accepted-manifest.json。

显式 TS 缺 key／owner 时运行同一个真实 ModelHost、稳定 journal、原 PG 恢复和可信 metadata。生成为明确 unconfigured，新预约先于任何 PG／预算写入拒绝；不填假 provider/model/owner。未配置只装配原确定性删除五步，模型恢复／重试／自动排队在持久修改前拒绝；合法 pending 导入、学习设置／关闭、手录／暂停和删除保留。默认能力 True 保留原租约恢复；False 同时限制领取及过期恢复，不改同 scope 无关模型任务。

SourceService、默认 TaskService 与原 TaskHost 使用同一 SharedModelPriorityControl 的真实 unconfirmed callback，无空回执替身或新仲裁器。配置齐全仍保留 reply 装配与 remote+None 严格检查；配置保存沿原完整重启。普通 Skill 管理保留 06 单一责任方及全部共享来源守卫；默认模式仍 Python。

锁定 DSH 0.2.1-rc.2／687f282e8625c6b8d11ff58211a90524be2e4317。官方 LlmRuntime 的空 adapter registry、registerAdapter 和 fiber dispose 已核；普通业务 TaskHost 无直接框架接口。本批不修改 DSH 核心／依赖或 schema111，具体官方来源及逐行证据沿 core-review 与 TaskHost 独立审查。

- 根 `verify.py minimal`：实际主树官方 profile 同时启动 TS 未配置控制面和 TS Skill 管理，1/1。
- 随后 `verify.py related`：38/38；含真实 PG／Unix 的未配置恢复、真实 Legacy 两态、删除五步和同 scope 过期任务不变、公开写前拒绝／合法导入、学习／整理、私有认证及跨模式安全门。
- 独立并行 `verify.py python`：16/16，原 reply wiring、启动协议和 Skill stop/drain/activate/close。`verify.py configured`：配置齐全官方 profile 1/1，真实 PG、共享 Python、本机合成 SSE、取消排空。`verify.py strict`：完整严格 TS exit 0。
- 每阶段记录实际 35 路径输入 SHA 并核执行后不变；最小→相关→配置齐全及 strict 按阶梯完成。原作者 core 29／37、TaskHost 7／76 不重复算作根运行。
- 独立 core 七源 Standards／Spec 0；TaskHost 九源独立审查 0 finding，另实跑 7／76。INDEX／VERIFY 在未配置状态的尾阶段执行为可选能力，本批明确采用 deletion-only，未签该扩展。
- 实际 npm run dev 两态管理页面、无 owner 的合成本人初始化及原完整重启已用 Computer Use 验证，全部正常退出清理。详见 ../ts-no-model-startup-app/README.md。

验收中一次初始化失败已保留：fixture 的 DISABLE_DOTENV=1 禁止重读刚保存的配置，独立两次 RED／单变量 GREEN／反向 RED 和原源码语义证实。只调整隔离 fixture 为明确的自有受控文件，不修改产品禁读语义。修改后原实际 CUA 初始化链及状态通过；不以修改断言掩盖原失败。

数据影响：只用纯合成独占 _test 库、私有 userData、本机 HTTP／Unix。真实聊天读取／发送、真实外部模型调用均 0；真实库未迁移、未重新编号。自有 App／测试进程及库目录已清理，共享 PG 保留；没有打包或 push。

边界：本批不签 05 真实双臂质量、07／08 整体交互、22 全部任务迁移或 24 完整切换回退；不改变最终默认模式。unknown 恢复及可信查询的独立 PG 证据不冒称 App 带非空旧账本的完整回退演练。
