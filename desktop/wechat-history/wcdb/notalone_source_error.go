package wcdb

import (
	"errors"
	"fmt"
)

// sourceReadUnavailable 仅保存 SQLite 数值错误，不携带路径、SQL 或正文。
// 它表示当前无法安全读取原件，不证明来源身份或结构已经变化。
type sourceReadUnavailable struct{ code int32 }

func (e *sourceReadUnavailable) Error() string {
	return fmt.Sprintf("source_read_temporarily_unavailable:%d", e.code)
}
func (e *sourceReadUnavailable) Temporary() bool { return true }

// IsSourceTemporarilyUnavailable 只接受本包保留的技术错误，不能按错误文案猜测。
func IsSourceTemporarilyUnavailable(err error) bool {
	var source *sourceReadUnavailable
	return errors.As(err, &source)
}

func notaloneSourceReadError(rc int32) error {
	switch rc & 0xff {
	case 5, 6, 10, 14: // BUSY、LOCKED、IOERR、CANTOPEN。
		return &sourceReadUnavailable{code: rc}
	case 8:
		// 普通 READONLY 和 DBMOVED 不能被误判为暂时锁或 SHM 初始化失败。
		switch rc {
		case 264, 520, 1288: // READONLY_RECOVERY、READONLY_CANTLOCK、READONLY_CANTINIT。
			return &sourceReadUnavailable{code: rc}
		}
	}
	return nil
}

func notaloneSQLiteSourceReadError(handle uintptr, rc int32) error {
	// 只有 READONLY 主码需进一步区分 CANTINIT 等扩展码。
	if handle != 0 && rc&0xff == 8 {
		boundedBootstrap.Lock()
		extended := boundedBootstrap.extendedErrorCode
		boundedBootstrap.Unlock()
		if extended != nil {
			if code := extended(handle); code&0xff == rc&0xff {
				rc = code
			}
		}
	}
	return notaloneSourceReadError(rc)
}
