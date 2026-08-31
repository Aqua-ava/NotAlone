import Foundation

// Follow 验证页的状态读取策略：首次状态尚未拿到时必须允许重试；
// 已知未开始的验证不需要每轮重复请求，验证进行中则持续刷新。
public enum FollowSmokeRefreshPolicy {
    public static func shouldRefresh(
        hasStatus: Bool,
        isActive: Bool?
    ) -> Bool {
        !hasStatus || isActive == true
    }
}
