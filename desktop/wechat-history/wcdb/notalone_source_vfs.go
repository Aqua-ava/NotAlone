package wcdb

import (
	"errors"
	"strings"
	"unsafe"

	"github.com/ebitengine/purego"
)

const notaloneSourceVFSName = "notalone-source-readonly-v2"

var notaloneSourceVFSSelector = []byte(notaloneSourceVFSName + "\x00")

// 固定 Tencent SQLCipher sqlite.h.in 的 sqlite3_vfs v3 ABI；只复制公开结构，不读 Unix 私有结构。
// 结构及名称使用固定 WCDB 的 sqlite3_malloc64 分配，注册后保留至进程退出。
type notaloneSQLiteVFS struct {
	Version, FileSize, MaxPath                                     int32
	Next, Name, Data                                               uintptr
	Open, Delete, Access, FullPathname                             uintptr
	DlOpen, DlError, DlSym, DlClose                                uintptr
	Randomness, Sleep, CurrentTime, GetLastError                   uintptr
	CurrentTimeInt64, SetSystemCall, GetSystemCall, NextSystemCall uintptr
}

var notaloneSourceVFS struct{ allocation, parent, openCallback, deleteCallback uintptr }

// Bootstrap 在自己的进程级互斥内调用一次；makeDefault=0，不改变合成写者与其他 SQLite 连接。
func notaloneBootstrapSourceVFS(library uintptr) error {
	if notaloneSourceVFS.allocation != 0 {
		return nil
	}
	if unsafe.Sizeof(notaloneSQLiteVFS{}) != 168 || unsafe.Offsetof(notaloneSQLiteVFS{}.Open) != 40 {
		return errors.New("source_vfs_abi_unsupported")
	}
	var find func(uintptr) uintptr
	var register func(uintptr, int32) int32
	var allocate func(uint64) uintptr
	var free func(uintptr)
	purego.RegisterLibFunc(&find, library, "sqlite3_vfs_find")
	purego.RegisterLibFunc(&register, library, "sqlite3_vfs_register")
	purego.RegisterLibFunc(&allocate, library, "sqlite3_malloc64")
	purego.RegisterLibFunc(&free, library, "sqlite3_free")
	parent := find(0)
	if parent == 0 {
		return errors.New("source_vfs_parent_missing")
	}
	base := (*notaloneSQLiteVFS)(unsafe.Pointer(parent))
	if base.Version != 3 || base.FileSize <= 0 || base.MaxPath <= 0 || base.Open == 0 || base.Delete == 0 || readCString(unsafe.Pointer(base.Name)) != "unix" {
		return errors.New("source_vfs_parent_unsupported")
	}
	var open func(uintptr, uintptr, uintptr, int32, uintptr) int32
	var deleteFile func(uintptr, uintptr, int32) int32
	purego.RegisterFunc(&open, base.Open)
	purego.RegisterFunc(&deleteFile, base.Delete)
	size := unsafe.Sizeof(notaloneSQLiteVFS{})
	allocation := allocate(uint64(size) + uint64(len(notaloneSourceVFSSelector)))
	if allocation == 0 {
		return errors.New("source_vfs_allocation_failed")
	}
	wrapper := (*notaloneSQLiteVFS)(unsafe.Pointer(allocation))
	*wrapper = *base
	wrapper.Next = 0
	wrapper.Name = allocation + size
	copy(unsafe.Slice((*byte)(unsafe.Pointer(wrapper.Name)), len(notaloneSourceVFSSelector)), notaloneSourceVFSSelector)
	openCallback := purego.NewCallback(func(_ uintptr, name uintptr, file uintptr, flags int32, outFlags uintptr) int32 {
		const originalTypes int32 = 0x00000100 | 0x00000800 | 0x00004000 | 0x00080000
		original := flags&originalTypes != 0
		if original {
			if name == 0 {
				if file != 0 {
					*(*uintptr)(unsafe.Pointer(file)) = 0
				}
				return 14
			}
			// wal.c 总以 RW|CREATE 请求 WAL；在公开 xOpen seam 改为真只读，再让 Unix VFS 回报真实 outFlags。
			flags = (flags &^ int32(SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|0x8|0x10)) | SQLITE_OPEN_READONLY
		}
		// 保留原始 zName 指针及其尾随 URI 参数；不能把它转换为 Go string 后重建。
		rc := open(parent, name, file, flags, outFlags)
		if rc == SQLITE_OK && original && outFlags != 0 {
			actual := *(*int32)(unsafe.Pointer(outFlags))
			if actual&SQLITE_OPEN_READONLY == 0 || actual&int32(SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE|0x8) != 0 {
				return 10
			}
		}
		return rc
	})
	deleteCallback := purego.NewCallback(func(_ uintptr, name uintptr, syncDirectory int32) int32 {
		if name != 0 && notaloneProtectedSourceDelete(readCString(unsafe.Pointer(name))) {
			return 8
		}
		return deleteFile(parent, name, syncDirectory)
	})
	wrapper.Open = openCallback
	wrapper.Delete = deleteCallback
	if register(allocation, 0) != SQLITE_OK {
		free(allocation)
		return errors.New("source_vfs_registration_failed")
	}
	notaloneSourceVFS.allocation = allocation
	notaloneSourceVFS.parent = parent
	notaloneSourceVFS.openCallback = openCallback
	notaloneSourceVFS.deleteCallback = deleteCallback
	return nil
}

func notaloneProtectedSourceDelete(path string) bool {
	notaloneSourceFiles.Lock()
	defer notaloneSourceFiles.Unlock()
	if notaloneSourceFiles.paths[path] > 0 {
		return true
	}
	// 主回滚 journal 同样属于原件；临时排序文件不匹配来源登记，仍交由原 Unix VFS 管理。
	return strings.HasSuffix(path, "-journal") && notaloneSourceFiles.paths[strings.TrimSuffix(path, "-journal")] > 0
}
