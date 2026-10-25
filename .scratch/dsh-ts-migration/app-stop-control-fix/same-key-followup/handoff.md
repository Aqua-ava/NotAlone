同键 Stop P2 候选已冻结；只改 1 个产品文件、2 个已有直接测试。
起始 HEAD：7a1f58a679245c6df84d88dfaafc3ff2c352c290；父任务当前 HEAD：a449fd873a456f8773bdf582b076b0eb473a7f51，三个文件基线相同。
审查 manifest SHA：0a0790358c539d647b09a3230b10c0640ba39eca618a4b83e1fceaf86003d68a。
业务 RED 已复现：旧 transportEnded unknown 抢占同键重试的 null Stop，新准备仍派发 1 次，中断 0。
原始反例日志：red-review-jobs / red-review-ipc；实际 workspace express 推广 RED：red-promoted-ipc。
修复一：cancelUserGeneration 反向选取最后匹配登记，与 states 同键覆盖一致；不删除旧 unknown。
修复二：退出／重载先等待同认证范围、同请求键的既有用户停止，防旧真实晚回执抢先 app_quit。
旧 unknown 仍由真实匹配回执收口，不猜未领取；无停止集合保持原快速返回。
产品：desktop/src/main/reply/assistant-generation-jobs.ts:459、497。
已有直接测试：desktop/tests/assistant-generation-preparation-stop.test.mjs:140、161；assistant-generation-stop.test.mjs:361。
新增 4 回归含真实旧协议 receipt 回调、准备停止、旧未知保留、晚回执在停止前／后与退出交错，均无派发。
inventory 第14/16行早已登记这两个文件，字节未改；没有新测试文件或框架。
相关停止／IPC／准备／执行 48/48；冻结独立边界及两条原 RED 6/6；desktop tsc --noEmit 通过。
最终同键 IPC：modelPostsBeforeCleanup=0、interruptsBeforeCleanup=1、stopError=null。
两个晚回执交错：当前 receipt 前中断 0，最终仅 retry/user_cancelled 1 次，modelCalls=0。
精确原／新源码 SHA、运行命令、raw/public SHA 见 manifest.json；可暂存三文件列表见 source-staging.json。
fix.patch 可独立反向检查；旧 implementation 和冻结审查原有 98 文件、三个用户文件及 index 指纹未变。
HEAD 前进来自父任务；本轮无 index/add/commit/push/PR、PG、真实资料、模型、App、微信或外发。
一切原件仓库外0700/0600；没有自有常驻资源。没有全量测试。
根继续独占实际 App/index；仅 npm run dev，禁打包/packaged；记忆语义 deferred、费用输出豁免不变。
交接后不再编辑源码或旧证据；候选范围只包含 source-staging.json 的三份源码。
