# DSH迁移自然收尾与接手入口
用户已要求当前工作自然收尾后交其他Agent；本轮停止，不自动续跑全迁移或开启下游。整迁移未完成。
本轮代码基线：`08e90b8f20bc6032e98828d506af2b2dac2932ee`；仅本地提交，无push/PR/打包。
已验收：01—06、09、18、19、23；其余状态与依赖保持 [planning.md](planning.md)。
07保持claimed：33正式文件已合入并提交；冻结target `a94a3d76d886227f96125744bc1ef71ec5492245`。
07证据：[模块与正式运行](task07-root-acceptance/module-runtime-stages.json)、[源提交](task07-root-acceptance/source-commit.json)、[冻结包](task07-implementation/v2/handoff.md)。
根实际HTTP最小1→相关TS42、Python最小1→19、正式launchDsh/主host/Legacy4、backendTS类型检查全过；无skip。
实际npmdev/CUA仅通过非空express、自动Skill实际读取、最近50条全文/顺序/说话者、候选修改版本1保存；本机HTTP2，外部模型0。
07尚需空白建议、指定/不用Skill、澄清换组、联系人切换/草稿重开、暂停/来源撤销等实际UI验收；本轮桌面点击/焦点不稳定，未确诊产品bug。
App部分结果与清理见 [partial-app-result.json](task07-root-app-acceptance/partial-app-result.json)；不能把API/模块通过改写成全UI通过。
10保持claimed：仅默认A→原B纵切冻结，未合主树；target `6e3a864ca5653311957b106e16130084b5f5c12a`，base `b0a6817582d92b4142977c486fe7a9366496cb88`。
10入口：[交接](task10-implementation/handoff.md)、[冻结补丁](task10-implementation/delivery-default-a-v2/default-a.patch)、[根接收核对](task10-root-closeout/frozen-patch-receipt.json)。
作者最终TS44/Python44及类型检查通过；根只读核50源/187依赖/7日志，临时index精确恢复目标树，未重复测试或执行主树集成。
10待完成生产TS唯一Worker/完整队列/观察调度/owner进度、历史bounded/nullable-proof迁移、整票验收；不启第二Worker。
10合入需精确处理host-plugin、host-reply与依赖host-storage/legacy-backend/reply-service的已知漂移，保留07 exploration、10 extraction两入口及23 ledger/设置。
21仍缺真实Vision 2500ms正例；只读审查无新增官方修复线索，见 [阻塞审计](foreground-vision-blocker-readonly-review/handoff.md)。不盲重测、重启、打包或用mock签收。
下一位Agent按用户新安排接手后，先补07未验UI，再处理10冻结包与整票余项；08及11等后续仍按原DAG，不提前解锁。
07/10目标已按用户要求paused、会话idle；23目标complete/idle。根子Agent、当前测试和迁移后台作业已结束。
本轮App已原生菜单Quit；自有进程/随机库/fixture/userData/socket/journal均0残留，私有原始证据0700/0600保留。
共享PG保留：`/tmp/notalone-dsh-migration-pg-20261024`，socket `/tmp:5432`；其他3库保留、客户端0，归属未确认不删除。
资源责任及私有清单SHA见 [resource-inventory.json](task10-root-closeout/resource-inventory.json)；接手者先核归属再清理，禁止FORCE DROP或杀未知PID。
私有App控制器及已清理locator在 `$HOME/.local/state/notalone/diagnostics/task07-root-app/`，源码SHA与说明见 [控制器说明](task07-root-app-acceptance/controller-usage.md)。
旧locator/PTY已失效，不复活旧场景。仅npm run dev；先预检/复用，确认实际Electron存活才用getApp，避免意外启动默认Electron。
保护三份外来修改：desktop/tests/fixtures/expression-preference-backend.py、expression-preferences-page.py及desktop/tests/memory-correction/retirement-react.test.mjs，均未暂存。
锁定DSH0.2.1-rc.2/官方687f282e8625c6b8d11ff58211a90524be2e4317；官方archive `/tmp/notalone-dsh-official-687f282`无.git，只声称文件SHA已核。
Node24：`$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`；Python：`$HOME/miniconda3/envs/NotAlone/bin/python`。
默认用户回复仍Python、TS显式optin；Python结构prepare仍保留，未做26退役。完整模型质量/费用/性能归25，既有付费首批已结案，不重开。
微信cloudy指定验收句早已唯一发送并签19；本轮零微信/真实资料/外部发送。产品发送始终用户手动。
前后公开扫描0；解析入口错误、交接标识RED及归档patch空白检查如实留证，正式代码/可编辑元数据空白检查0，冻结证据字节不改。
