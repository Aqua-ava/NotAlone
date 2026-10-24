# 共享集成注意
- 本补丁是canonical b0a68175→target的50路径变更，不覆盖根共享工作树或index。
- 07冻结a94a3d76新增/internal/exploration与ExplorationService；本票新增/internal/extraction。两个私有入口都需保留。
- host-plugin只增加私有路径分派；沿原public与private token边界，不重排23 ledger/设置路由。
- host-reply同时受07改动：本票复用原provider/ModelHost/pending关闭屏障，不能另开adapter/arbiter。
- host-model-accounting仅为extract_memory开放实际受信TS provider；原Python provider/其他step限制保留。
- host-model-runtime仅新增显式extraction配置、同私有URL/token与callExtraction，不改23其他行为。
- Python共同文件及所有before/target SHA已列manifest.shared_merge_paths；根逐hunk合并07/23。
- 原B仍由Python唯一写入；TS task-store/pipeline不能直接开启第二Worker。全TS队列切换属后续工作。
- standalone实际host验收使用人工claim，未据此签Worker领取/完整队列/owner进度/App。
