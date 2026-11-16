package wcdb

import (
	"errors"
	"os"
	"sync"
	"syscall"
)

type notaloneSourceFileIdentity struct {
	device uint64
	inode  uint64
}
type notaloneSourcePoolKey struct {
	identity  notaloneSourceFileIdentity
	eventOnly bool
}
type notaloneSourcePooledFile struct {
	file    *os.File
	key     notaloneSourcePoolKey
	users   int
	regular bool
	path    string
}

var notaloneSourceFiles = struct {
	sync.Mutex
	active     int
	pending    map[notaloneSourceFileIdentity][]*os.File
	unknown    []*os.File
	pool       map[notaloneSourcePoolKey]*notaloneSourcePooledFile
	byFile     map[*os.File]*notaloneSourcePooledFile
	byFD       map[int]*notaloneSourcePooledFile
	identities map[notaloneSourceFileIdentity]int
	paths      map[string]int
}{pending: make(map[notaloneSourceFileIdentity][]*os.File), pool: make(map[notaloneSourcePoolKey]*notaloneSourcePooledFile), byFile: make(map[*os.File]*notaloneSourcePooledFile), byFD: make(map[int]*notaloneSourcePooledFile), identities: make(map[notaloneSourceFileIdentity]int), paths: make(map[string]int)}

type notaloneSourceObservation struct {
	path     string
	identity notaloneSourceFileIdentity
	exists   bool
}
type notaloneSourceFileLease struct {
	once    sync.Once
	sources []notaloneSourceObservation
}

// 每个源 SQLite 连接在首次打开前登记，跨快照、临时读者与异步关闭共享。
// 不在连接首查询才打开 SHM 的窗口抢先关闭其他原件 FD；全部连接结束后统一排空。
func notaloneAcquireSourceFiles(path string) *notaloneSourceFileLease {
	notaloneSourceFiles.Lock()
	defer notaloneSourceFiles.Unlock()
	lease := &notaloneSourceFileLease{}
	notaloneSourceFiles.active++
	for _, source := range []string{path, path + "-wal", path + "-shm"} {
		notaloneSourceFiles.paths[source]++
		var st syscall.Stat_t
		if syscall.Stat(source, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG {
			lease.sources = append(lease.sources, notaloneSourceObservation{path: source})
			continue
		}
		identity := notaloneSourceFileIdentity{uint64(st.Dev), st.Ino}
		notaloneSourceFiles.identities[identity]++
		lease.sources = append(lease.sources, notaloneSourceObservation{path: source, identity: identity, exists: true})
	}
	return lease
}

func (lease *notaloneSourceFileLease) release() {
	if lease == nil {
		return
	}
	lease.once.Do(func() {
		notaloneSourceFiles.Lock()
		defer notaloneSourceFiles.Unlock()
		notaloneSourceFiles.active--
		for _, source := range lease.sources {
			notaloneSourceFiles.paths[source.path]--
			if notaloneSourceFiles.paths[source.path] == 0 {
				delete(notaloneSourceFiles.paths, source.path)
			}
			if source.exists {
				notaloneSourceFiles.identities[source.identity]--
				if notaloneSourceFiles.identities[source.identity] == 0 {
					delete(notaloneSourceFiles.identities, source.identity)
				}
			}
		}
		for _, entry := range notaloneSourceFiles.byFile {
			if entry.users == 0 && !notaloneProtectPooledSource(entry) {
				_ = notaloneClosePooledSource(entry)
			}
		}
		if notaloneSourceFiles.active != 0 {
			return
		}
		for _, entry := range notaloneSourceFiles.byFile {
			if entry.users == 0 {
				notaloneClosePooledSource(entry)
			}
		}
		// 最后一个源 SQLite 连接已确认关闭，此时额外 FD 的 close 不再释放活跃读者的锁。
		for key, files := range notaloneSourceFiles.pending {
			for _, file := range files {
				_ = file.Close()
			}
			delete(notaloneSourceFiles.pending, key)
		}
		for _, file := range notaloneSourceFiles.unknown {
			_ = file.Close()
		}
		notaloneSourceFiles.unknown = nil
	})
}

// CloseSourceFile 关闭原始页、盐与守卫句柄；存在任何源 SQLite 连接时延迟实际 close。
// POSIX 锁属于进程，不能只依据“这个快照已关闭”释放同文件的额外 FD。
func CloseSourceFile(file *os.File) error {
	if file == nil {
		return nil
	}
	notaloneSourceFiles.Lock()
	defer notaloneSourceFiles.Unlock()
	if entry := notaloneSourceFiles.byFile[file]; entry != nil {
		if entry.users <= 0 {
			return errors.New("source_file_already_released")
		}
		entry.users--
		if entry.users == 0 && !notaloneProtectPooledSource(entry) {
			return notaloneClosePooledSource(entry)
		}
		return nil
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &st); err != nil {
		if notaloneSourceFiles.active > 0 {
			// 仍保存引用，避免无法确认身份的 FD 被 os.File finalizer 在活跃读者期间关闭。
			notaloneSourceFiles.unknown = append(notaloneSourceFiles.unknown, file)
			return nil
		}
		return file.Close()
	}
	if st.Mode&syscall.S_IFMT == syscall.S_IFREG && notaloneSourceFiles.active > 0 {
		key := notaloneSourceFileIdentity{uint64(st.Dev), st.Ino}
		notaloneSourceFiles.pending[key] = append(notaloneSourceFiles.pending[key], file)
		return nil
	}
	return file.Close()
}

// 守卫的 O_EVTONLY FD 也会释放同进程主库锁，必须走相同原件注册表。
func CloseSourceDescriptor(fd int) error {
	if fd < 0 {
		return nil
	}
	notaloneSourceFiles.Lock()
	entry := notaloneSourceFiles.byFD[fd]
	notaloneSourceFiles.Unlock()
	if entry != nil {
		return CloseSourceFile(entry.file)
	}
	file := os.NewFile(uintptr(fd), "notalone-source-guard")
	if file == nil {
		return errors.New("source_file_descriptor_invalid")
	}
	return CloseSourceFile(file)
}

// OpenSourceFile 复用同一原件的额外只读 FD，避免长快照期间重复元数据／图片操作累积句柄。
// 共享普通文件只使用 ReadAt，不共享可变的读取位置；O_EVTONLY 与正文读者分别复用。
func OpenSourceFile(path string, flags int) (*os.File, error) {
	if flags&syscall.O_ACCMODE != syscall.O_RDONLY || flags&(syscall.O_CREAT|syscall.O_TRUNC|syscall.O_APPEND) != 0 {
		return nil, errors.New("source_file_open_mode_invalid")
	}
	flags |= syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	notaloneSourceFiles.Lock()
	defer notaloneSourceFiles.Unlock()
	var before syscall.Stat_t
	if err := syscall.Lstat(path, &before); err != nil {
		return nil, err
	}
	if before.Mode&syscall.S_IFMT != syscall.S_IFREG && before.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return nil, syscall.ELOOP
	}
	regular := before.Mode&syscall.S_IFMT == syscall.S_IFREG
	key := notaloneSourcePoolKey{identity: notaloneSourceFileIdentity{uint64(before.Dev), before.Ino}, eventOnly: flags&syscall.O_EVTONLY != 0}
	if regular {
		if entry := notaloneSourceFiles.pool[key]; entry != nil {
			entry.users++
			return entry.file, nil
		}
	}
	fd, err := syscall.Open(path, flags, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	var opened syscall.Stat_t
	if err = syscall.Fstat(fd, &opened); err != nil || opened.Dev != before.Dev || opened.Ino != before.Ino {
		// 文件在打开期间换代：不使用它，也不在活跃 SQLite 期间立即 close。
		if notaloneSourceFiles.active > 0 {
			notaloneSourceFiles.unknown = append(notaloneSourceFiles.unknown, file)
		} else {
			_ = file.Close()
		}
		return nil, errors.New("source_file_open_instance_changed")
	}
	entry := &notaloneSourcePooledFile{file: file, key: key, users: 1, regular: regular, path: path}
	if regular {
		notaloneSourceFiles.pool[key] = entry
	}
	notaloneSourceFiles.byFile[file] = entry
	notaloneSourceFiles.byFD[fd] = entry
	return file, nil
}

func OpenSourceDescriptor(path string, flags int) (int, error) {
	file, err := OpenSourceFile(path, flags)
	if err != nil {
		return -1, err
	}
	return int(file.Fd()), nil
}

// 调用者须持有注册表锁；只有没有逻辑持有者且没有源 SQLite 连接时关闭普通文件。
func notaloneClosePooledSource(entry *notaloneSourcePooledFile) error {
	delete(notaloneSourceFiles.byFile, entry.file)
	delete(notaloneSourceFiles.byFD, int(entry.file.Fd()))
	if entry.regular {
		delete(notaloneSourceFiles.pool, entry.key)
	}
	return entry.file.Close()
}

// 打开后按 dev+inode 复验全部路径；变化时结束本次打开，不接纳跨实例的读者。
func (lease *notaloneSourceFileLease) unchanged() bool {
	notaloneSourceFiles.Lock()
	defer notaloneSourceFiles.Unlock()
	for _, source := range lease.sources {
		var st syscall.Stat_t
		err := syscall.Stat(source.path, &st)
		if !source.exists {
			if !os.IsNotExist(err) {
				return false
			}
			continue
		}
		if err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || (notaloneSourceFileIdentity{uint64(st.Dev), st.Ino}) != source.identity {
			return false
		}
	}
	return true
}

// 普通原件读 FD 保守等待全部源连接；图片等非数据库的 O_EVTONLY 守卫及时关闭。
// 是否属于原库按当前连接登记的路径及文件身份核对，不按扩展名猜测。
func notaloneProtectPooledSource(entry *notaloneSourcePooledFile) bool {
	if !entry.regular || notaloneSourceFiles.active == 0 {
		return false
	}
	if !entry.key.eventOnly {
		return true
	}
	return notaloneSourceFiles.identities[entry.key.identity] > 0 || notaloneSourceFiles.paths[entry.path] > 0
}
