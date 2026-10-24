# 任务19 D5 冻结证据独立复核

结论：D5「首流code7→自然退避→新PID重开→旧cursor接续→去重保存」有可信执行证据，未发现产品缺陷；本case有1项覆盖缺口及1项不阻断的记录精度问题。不能单凭本包签整个D5全部分支或任务19。

## E1：非空排除项在重连后的不读分支未直接执行（覆盖缺口）

- coverage-matrix.json:964明确要求「未授权/排除不读」；本包handoff.md:2宣称本缺口PASS，:14称排除项不变。
- 原始$RUN/raw-evidence.json两份authority快照的wechat_sync_exclusion均为空；本次只读投影frozen-facts.json:33记录before计数0，:41记录整份前后相等。
- probe.mjs:23–25只建owner/账号；:35发出friend-a及outside-b元数据；:62仅确认friend-a；没有建非空排除记录的步骤。outside-b是未授权会话，不能替代已撤销/删除排除对象。
- 因而可以认定未授权outside-b两代流均未读正文，不能认定本case已经实际观察「已有排除对象重连后不读」。根可明确组合既有19-B5/B6已冻结证据，或保留该分支待证；本审查不执行补测，不将缺证推成产品缺陷。

## E2：首轮至通过轮的夹具差异描述少记一项（不阻断）

- handoff.md:22/result.json:144仅列shebang/审计装配及authority表名修正。
- 逐字比较两份已校验SHA的$ATTEMPT1/probe.mjs与$RUN/probe.mjs，还新增了probe.mjs:37的--mode取值必须为sessions的分支条件。
- 两代实际argv均为--mode sessions，原条件亦命中；该收紧不改变本case成功解释，也未修改产品。宜在根验收记录中补全差异，避免把「仅」解释成完整逐行差异。

## 已交叉核实的执行链

- 执行probe.mjs与分享版SHA逐字相同；:53走真实launchDsh，公开runtime为DSH、Legacy存在、wechatIncremental=typescript、reply=unconfigured（result.json:8–42）。
- 第一CLI PID48244于1792829775399记录code7并process.exit(7)（probe.mjs:41）；真实stream适配器以child close非0分类cli_follow_failed（sync-incremental-cli-stream.ts:45–48），公开状态确实转为该失败及bounded_polling。
- 第二CLI PID48406于1792829780147启动，间隔4748ms；argv带原metadata cursor=global-1-outside。原heartbeat与cycle远程接缝见sync_host.py:634–675、incremental_remote.py:199；engine:164–167设置3秒首退避，:204–205到期重开。
- enable与disable之间95个公开请求全部是GET /api/sync/status；总共仅初次enable1次，无check/retry/follow控制或改时钟。GET路径只取既有report（app.py:1294–1307；sync_host.py:370–372），不会调用engine.requestCheck():89重置退避。
- ID2在第二流出现前已保存；第二代两页均重放2并带3，正文cursor从message-2接续到message-3。最终2个message UUID、stable IDs=2/3、6条source_ref、4次observation、6条处理回执（2 created+4 reused），2条派生收据task_id=null；owner/contact/binding一致，原baseline/账号/授权JSON不变。
- 正文调用均限friend-a，无--history或scope_violation；未授权outside-b不读。处理model_read_status均not_claimed；模型/任务/出站/reply计数均0，Node402+Python38审计无外网尝试；该结论只覆盖记录的进程内审计范围。

## 来源、首轮失败及清理

- 30条manifest记录的raw/shared SHA全部吻合；额外冻结38个仓外顶层记录SHA、全部19个分享文件SHA。两轮source归档各734文件逐一读取核hash，无提取/执行；三份树SHA均5aa9d99c2792d99cb456142206a31d3c28059e18e02afeddab3aed3194d8b7c7。
- 734输入中728个tracked文件与固定43ae208f3c4bc38116bfee62ed4665923674e682逐字相同，另6个为未跟踪egg-info；当前主树也734/734相同。当前256fecc1fb1a3dcb49070bfaf663c635cb958491仅增加离线工具/其测试与记录；来源一致仅用于界定执行适用范围，没有当作执行本身。
- 5份官方源hash独立复算吻合DSH0.2.1-rc.2/687f282e8625c6b8d11ff58211a90524be2e4317。prepare执行原件与分享版的路径解析/私有指针差异保留双SHA，未冒称重执行。
- 首轮在confirm时500、CLI命令0、尚未enable；归档原CLI字节SHA5f27ec5b5709dd45f2bc5ca1c38839b1718dca40a22c1f243ae893f263baa990与exec-format-proof吻合，shebang确指脚本包装器，既有逐字诊断errno8。因此支持夹具传输失败解释，不能作为产品RED。
- probe stdout/pass、空stderr、result-raw和最终result一致。既有清理记录表明正常disable后跨3.5秒无CLI，再公开shutdown；两轮runner/DSH/Legacy/CLI、info/锁/profile/socket清理，两测试库不存在，共享PG启动时间未变，展开staging清理16,454,308字节。finalize.py:21–32先只读全表归档再drop自有测试库；未清journal/改业务行绕过门禁。
- 本审查只检查冻结清理证据及生成代码，不新查进程/DB，不把历史清理证明改称当前运行状态证明；原始记录仍仅仓外。

D6：pending。根尚未给冻结handoff，本次未进入其活跃目录；不签异常退出恢复、全部私聊、20停机追赶、实际App/微信或任务19整体。
