# 三项夹具启动准备修复

- 仅修改父目录 `fixture.mjs`，新证据全部在本目录；旧 manifest、SHA256SUMS、handoff、operations、verification 和 700 文件清单逐字保持，旧 E5D 记录仍是历史，不据此改写 GUI 结果。
- 短路径：默认夹具改在 `/tmp/notalone-final-native-*` 创建自有 0700 目录；record 与 prepare 输出明确保存 `temporaryDirectory`。启动脚本只使用该目录的 `tmp`，显式 close 随自有根清理，旧 session 仍可清理。
- 真实开发租约回归：继承长 TMPDIR 时旧路径 264 字节，实际 acquire 得到 EINVAL；修复后 88 字节，可获取、识别现有租约、释放、重获并再次释放。未启动 Electron。
- 源码闭包：增加 desktop 根的 managed-runtime-contract.mjs / .d.mts、tsconfig.json 和 wechat-sources.lock.json。旧缺模块复现保存在 closure-red-result.json；实际 main/preload/renderer 构建通过，只在内存产生结果并保存无正文 SHA。
- watch 闭包：从当前 dev.mjs 声明提取三条路径，逐一实际递归 watch / close；兼容 Python watch 根只建空 `backend/src/notalone`。负例删除该自有空目录后得到 ENOENT，恢复后均通过；没有复制或执行 Python。
- 新快照为当前源码 704 文件，精确值见 verification.json 与 staging-source.sha256；不要求与旧 700 文件 pin 相同，不能把旧真实 App 失败记录当作新代码 GUI 通过。
- 有限验证入口：Node 24+ 执行 `node .scratch/dsh-ts-migration/final-native-basic-fixture/followup-short-socket/lease-regression.mjs green`。不要运行旧 self-check.mjs 覆盖旧冻结结果。
- 此回归还在独立进程执行 prepare、inspect、close，核对合成种子、迁移、空 key、TS runtime 与来源归属；自有测试库和目录均清理，构建子进程明确 await esbuild.stop()。
- root 当前私有快照、短目录和正在运行的实例未触碰；未启动 App / DSH / 微信 / 模型，未读取原 .env、资料或账本，未改产品、index 或其他 scratch。
- 后续最终实际 App 验收需由 root 在合适时点调用新 prepare，按新清单核对源码，再经 npm run dev + CUA 执行；本次仅证明准备与构建就绪，不签收 GUI、真实渠道、模型或在途生成取消。
- 新 manifest 与 SHA256SUMS 固定本工具版本、红/绿证据及 staging 源码；失败时只保留自有现场，不强杀进程或强制删库。
