本次只读独立审查已结束；Standards 1项P2，业务/自动恢复Spec 0项阻碍；19已resolved状态不重签。
P2：reconnect-fixture.mjs:34–40的close先assert再f.close，原断言失败会阻断清库/目录，且closed缓存reject令t.after无法补偿。
建议保留原自然退出/PG排空断言为失败，随后执行已核身份自有资源的有界紧急清理；不以提前FORCE清库掩盖故障。未知归属仍保留现场。
详细控制流/规则/行号见findings.md；仅静态核验，没有运行测试/DB/HTTP/CLI/App或改原候选/main/index/票。
实际链为launchDsh→官方profile→当前host-plugin/Legacy与公共HTTP；fake只替外部只读CLI，模型runtime必须unconfigured。
reconnect仅一次enable、无check/retry；metadata global-1-outside与message-* cursor明确分开；父丢失第二次启动只GET。
parent-loss SIGKILL仅已核身份launcher helper；自然停读/旧锁回收/journal/原UUID来源/receipt保留均有断言，不冒充Electron故障或20追赶。
父丢失失败teardown按身份收尾、未知归属明确保留现场；未找到第二项确定阻碍。原测试发现glob不会执行helper。
已审四文件精确SHA：
backend-ts/test/sync-incremental-reconnect-fixture.mjs bb0a6e6286c3bbd148ce43e281680a431e4dcf31ecd2b2571431d14814e34427
backend-ts/test/sync-incremental-reconnect.test.mjs a751910a3c3626e318908fb3bccafff3909ae4b5a1c1706c283498dceb0324e5
backend-ts/test/sync-incremental-parent-loss.test.mjs 5e649e6fa3ba1dfabd8264622bcd591f9bfcb3dc35388495642cf46fb0743d9f
backend-ts/test/sync-incremental-parent-loss-helper.mjs 4f857a975158c1b8212c74505383f51fc87b945e942e4b7992afb59427e0ee6f
DSH固定0.2.1-rc.2/687f282；已核profile-boot:283–308/323、process-shutdown:4–69与现launcher白名单，未新增或猜测API。
根负责应用后仅两个实际case；本轮只读结论不使用作者旧PASS签运行，不重复旧矩阵，不启动App/微信，不联网/安装/打包/push。
