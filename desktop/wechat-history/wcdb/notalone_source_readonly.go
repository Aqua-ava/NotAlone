package wcdb

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"unsafe"
)

const notaloneSQLiteOpenURI int32 = 0x00000040
const notaloneRawSourceSafety = "notalone-raw-source-safety:wechat-raw-source-readonly-v2"

// 原始 DB 只读标志不约束 Unix VFS 的 SHM；从首次连接起同时强制 URI 及只读旁车。
// 路径全部作为 URL 的 Path 编码，文件名中的 ?、#、% 不能注入其他 SQLite URI 参数。
func notaloneSourceReadOnlyFilename(path string) (string, error) {
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
		return "", errors.New(notaloneRawSourceSafety + ":invalid_path")
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&readonly_shm=1"}
	return u.String(), nil
}

// 所有正式原库打开统一经过只读 VFS；DB／WAL／SHM 均无可写、immutable 或 nolock 回退。
func notaloneOpenReadOnlySource(path string, key []byte) (*DB, error) {
	filename, err := notaloneSourceReadOnlyFilename(path)
	if err != nil {
		return nil, err
	}
	lease := notaloneAcquireSourceFiles(path)
	accepted := false
	retained := false
	defer func() {
		if !accepted && !retained {
			lease.release()
		}
	}()
	var handle uintptr
	if rc := sqlite3_open_v2(filename, &handle, SQLITE_OPEN_READONLY|notaloneSQLiteOpenURI, &notaloneSourceVFSSelector[0]); rc != SQLITE_OK {
		// 先读取 extended errcode，再关闭失败连接；临时读失败不冒充来源换代。
		sourceErr := notaloneSQLiteSourceReadError(handle, rc)
		if handle != 0 && sqlite3_close_v2(handle) != SQLITE_OK {
			retained = true
		}
		if sourceErr != nil {
			return nil, sourceErr
		}
		return nil, fmt.Errorf("source_read_open_failed:%d", rc)
	}
	if len(key) > 0 {
		if rc := sqlite3_key_v2(handle, "main", unsafe.Pointer(&key[0]), int32(len(key))); rc != SQLITE_OK {
			if sqlite3_close_v2(handle) != SQLITE_OK {
				retained = true
			}
			return nil, fmt.Errorf("source_read_key_failed:%d", rc)
		}
	}
	if !lease.unchanged() {
		if sqlite3_close_v2(handle) != SQLITE_OK {
			retained = true
		}
		return nil, notaloneSourceReadError(10)
	}
	db := &DB{handle: handle, path: path, sourceLease: lease}
	_ = db.Exec("PRAGMA busy_timeout=5000")
	accepted = true
	return db, nil
}
