//go:build darwin

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
)

type notaloneWatchedSource struct {
	path      string
	fd        int
	stat      syscall.Stat_t
	directory bool
}

// 守卫仅证明本进程持有期间的指定目录与文件实例；不是跨重启的来源代次。
// 目录事件不能证明永不丢失，事件或实例核验异常时均保持失效。
type notaloneSourceGuard struct {
	mu          sync.Mutex
	queue       int
	watches     []notaloneWatchedSource
	fingerprint string
	invalid     bool
	closed      bool
	lost        chan struct{}
	lostOnce    sync.Once
	monitoring  bool
	monitorDone chan struct{}
	closeDone   chan struct{}
	closeError  error
}

func newNotaloneSourceGuard(directory string, files []string) (*notaloneSourceGuard, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || len(files) > 1024 {
		return nil, errors.New("source_guard_input_invalid")
	}
	selected := append([]string(nil), files...)
	sort.Strings(selected)
	for i, file := range selected {
		if !filepath.IsAbs(file) || filepath.Clean(file) != file || filepath.Dir(file) != directory || i > 0 && selected[i-1] == file {
			return nil, errors.New("source_guard_input_invalid")
		}
	}
	guard := &notaloneSourceGuard{queue: -1, lost: make(chan struct{}), closeDone: make(chan struct{})}
	accepted := false
	defer func() {
		if !accepted {
			_ = guard.Close()
		}
	}()
	queue, err := syscall.Kqueue()
	if err != nil {
		return nil, errors.New("source_guard_unavailable")
	}
	guard.queue = queue
	syscall.CloseOnExec(queue)
	if err := guard.add(directory, true); err != nil {
		return nil, err
	}
	for _, file := range selected {
		if err := guard.add(file, false); err != nil {
			return nil, err
		}
	}
	// 监听前后的路径与打开实例双核验，期间的目录变动也必须拒绝。
	if err := guard.Check(); err != nil {
		return nil, err
	}
	guard.fingerprint = notaloneSourceFingerprint(guard.watches)
	accepted = true
	return guard, nil
}

func notaloneSourceFingerprint(watches []notaloneWatchedSource) string {
	hash := sha256.New()
	for _, watched := range watches {
		name := filepath.Base(watched.path)
		if watched.directory {
			name = "."
		}
		_ = binary.Write(hash, binary.BigEndian, uint64(len(name)))
		_, _ = hash.Write([]byte(name))
		for _, value := range []uint64{uint64(watched.stat.Dev), watched.stat.Ino, uint64(watched.stat.Birthtimespec.Sec), uint64(watched.stat.Birthtimespec.Nsec), uint64(watched.stat.Nlink)} {
			_ = binary.Write(hash, binary.BigEndian, value)
		}
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func notaloneSameInstance(a, b syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Birthtimespec == b.Birthtimespec && a.Nlink == b.Nlink && a.Mode&syscall.S_IFMT == b.Mode&syscall.S_IFMT
}

func (guard *notaloneSourceGuard) add(path string, directory bool) error {
	var before syscall.Stat_t
	if syscall.Lstat(path, &before) != nil || before.Nlink == 0 {
		return errors.New("source_guard_instance_invalid")
	}
	kind := uint16(syscall.S_IFREG)
	if directory {
		kind = syscall.S_IFDIR
	}
	if before.Mode&syscall.S_IFMT != kind {
		return errors.New("source_guard_instance_invalid")
	}
	fd, err := syscall.Open(path, syscall.O_EVTONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("source_guard_instance_unavailable")
	}
	guard.watches = append(guard.watches, notaloneWatchedSource{path: path, fd: fd, stat: before, directory: directory})
	var opened syscall.Stat_t
	if syscall.Fstat(fd, &opened) != nil || !notaloneSameInstance(before, opened) {
		return errors.New("source_guard_instance_changed")
	}
	var event syscall.Kevent_t
	syscall.SetKevent(&event, fd, syscall.EVFILT_VNODE, syscall.EV_ADD|syscall.EV_CLEAR)
	event.Fflags = syscall.NOTE_RENAME | syscall.NOTE_DELETE | syscall.NOTE_REVOKE | syscall.NOTE_LINK
	if directory {
		event.Fflags |= syscall.NOTE_WRITE
	}
	// 文件不监听 WRITE/EXTEND：已有正文文件与 WAL 的正常提交不等于实例换代。
	var events [1]syscall.Kevent_t
	zero := syscall.Timespec{}
	if count, err := syscall.Kevent(guard.queue, []syscall.Kevent_t{event}, events[:], &zero); err != nil || count != 0 {
		return errors.New("source_guard_watch_failed")
	}
	return nil
}

func (guard *notaloneSourceGuard) checkEvents() bool {
	var events [1]syscall.Kevent_t
	zero := syscall.Timespec{}
	count, err := syscall.Kevent(guard.queue, nil, events[:], &zero)
	// 包括 EV_ERROR/EOF 及未知事件：任何返回事件都不能继续宣称连续。
	return err == nil && count == 0
}

func (guard *notaloneSourceGuard) Check() error {
	if guard == nil {
		return errors.New("source_guard_closed")
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if guard.closed {
		return errors.New("source_guard_closed")
	}
	if guard.invalid {
		return errors.New("source_guard_changed")
	}
	valid := guard.checkEvents()
	for _, watched := range guard.watches {
		var pathStat, openStat syscall.Stat_t
		if syscall.Lstat(watched.path, &pathStat) != nil || syscall.Fstat(watched.fd, &openStat) != nil || !notaloneSameInstance(watched.stat, pathStat) || !notaloneSameInstance(watched.stat, openStat) {
			valid = false
			break
		}
		if watched.directory && (pathStat.Mtimespec != watched.stat.Mtimespec || pathStat.Ctimespec != watched.stat.Ctimespec || openStat.Mtimespec != watched.stat.Mtimespec || openStat.Ctimespec != watched.stat.Ctimespec) {
			valid = false
			break
		}
	}
	if !valid || !guard.checkEvents() {
		guard.invalid = true
		guard.lostOnce.Do(func() { close(guard.lost) })
		return errors.New("source_guard_changed")
	}
	return nil
}

// 持续监听目录和文件实例变化；任何事件均终止可信期间。
func (guard *notaloneSourceGuard) StartMonitor() error {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if guard.closed || guard.invalid {
		return errors.New("source_guard_changed")
	}
	if guard.monitoring {
		return nil
	}
	var user syscall.Kevent_t
	syscall.SetKevent(&user, 1, syscall.EVFILT_USER, syscall.EV_ADD|syscall.EV_CLEAR)
	zero := syscall.Timespec{}
	if count, err := syscall.Kevent(guard.queue, []syscall.Kevent_t{user}, nil, &zero); err != nil || count != 0 {
		return errors.New("source_guard_watch_failed")
	}
	guard.monitoring = true
	guard.monitorDone = make(chan struct{})
	queue := guard.queue
	go func() {
		defer close(guard.monitorDone)
		var events [1]syscall.Kevent_t
		_, _ = syscall.Kevent(queue, nil, events[:], nil)
		guard.mu.Lock()
		defer guard.mu.Unlock()
		// 阻塞监听无论因事件还是异常返回，都不能继续宣称守卫有效。
		if !guard.closed {
			guard.invalid = true
			guard.lostOnce.Do(func() { close(guard.lost) })
		}
	}()
	return nil
}

func (guard *notaloneSourceGuard) Lost() <-chan struct{} { return guard.lost }

func (guard *notaloneSourceGuard) Fingerprint() string {
	if guard == nil {
		return ""
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	return guard.fingerprint
}

// 只读取初始白名单的实例摘要，不访问新路径；调用方仍须用 Check 核验存活状态。
// 单文件摘要不包含同目录其他分片，使新增分片不会改变旧分片的实例编号。
func (guard *notaloneSourceGuard) FileFingerprint(file string) (string, error) {
	if guard == nil {
		return "", errors.New("source_guard_closed")
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if guard.closed || guard.invalid {
		return "", errors.New("source_guard_changed")
	}
	for _, watched := range guard.watches {
		if !watched.directory && watched.path == file {
			return notaloneSourceFingerprint([]notaloneWatchedSource{watched}), nil
		}
	}
	return "", errors.New("source_guard_file_not_selected")
}

func (guard *notaloneSourceGuard) Close() error {
	if guard == nil {
		return nil
	}
	guard.mu.Lock()
	if guard.closed {
		done := guard.closeDone
		guard.mu.Unlock()
		<-done
		return guard.closeError
	}
	guard.closed = true
	guard.lostOnce.Do(func() { close(guard.lost) })
	failed := false
	if guard.monitoring && guard.queue >= 0 {
		var wake syscall.Kevent_t
		syscall.SetKevent(&wake, 1, syscall.EVFILT_USER, 0)
		wake.Fflags = syscall.NOTE_TRIGGER
		zero := syscall.Timespec{}
		_, err := syscall.Kevent(guard.queue, []syscall.Kevent_t{wake}, nil, &zero)
		failed = err != nil
	}
	done := guard.monitorDone
	guard.mu.Unlock()
	// 不复用队列描述符，直到阻塞监听确认退出。
	if done != nil && !failed {
		<-done
	}
	guard.mu.Lock()
	if guard.queue >= 0 && syscall.Close(guard.queue) != nil {
		failed = true
	}
	guard.queue = -1
	for i := range guard.watches {
		if syscall.Close(guard.watches[i].fd) != nil {
			failed = true
		}
		guard.watches[i].fd = -1
	}
	if failed {
		guard.closeError = errors.New("source_guard_close_failed")
	}
	close(guard.closeDone)
	err := guard.closeError
	guard.mu.Unlock()
	return err
}
