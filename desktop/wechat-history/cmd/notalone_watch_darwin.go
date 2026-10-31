//go:build darwin

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
)

type notaloneKeventCall func(int, []syscall.Kevent_t, []syscall.Kevent_t, *syscall.Timespec) (int, error)

type notaloneWatchedSource struct {
	path      string
	fd        int
	stat      syscall.Stat_t
	directory bool
}

// 守卫仅证明本进程持有期间的指定目录与文件实例；不是跨重启的来源代次。
// 目录写事件只唤醒白名单复核；旁车文件的正常生命周期不代表来源换代。
type notaloneSourceGuard struct {
	mu           sync.Mutex
	queue        int
	kevent       notaloneKeventCall
	watches      []notaloneWatchedSource
	processes    []notaloneProcessIdentity
	fingerprint  string
	invalid      bool
	closed       bool
	lost         chan struct{}
	lostOnce     sync.Once
	monitoring   bool
	monitorDone  chan struct{}
	closeDone    chan struct{}
	closeError   error
	messageFiles []string
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
	guard := &notaloneSourceGuard{queue: -1, lost: make(chan struct{}), closeDone: make(chan struct{}), kevent: syscall.Kevent}
	messageCatalog := len(selected) > 0
	for _, file := range selected {
		messageCatalog = messageCatalog && msgShardRE.MatchString(filepath.Base(file))
	}
	if messageCatalog {
		guard.messageFiles = selected
	}
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
	// 监听前后核对路径、打开实例与分片名单，目录旁车变动不改变来源身份。
	if err := guard.Check(); err != nil {
		return nil, err
	}
	guard.fingerprint = notaloneAliasedFingerprint(notaloneSourceFingerprint(guard.watches), notaloneSourceIdentityAliases)
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
		// APFS 目录链接数随普通条目变化，不属于目录实例身份。
		linkCount := uint64(watched.stat.Nlink)
		if watched.directory {
			linkCount = 0
		}
		for _, value := range []uint64{watched.stat.Ino, uint64(watched.stat.Birthtimespec.Sec), uint64(watched.stat.Birthtimespec.Nsec), linkCount} {
			_ = binary.Write(hash, binary.BigEndian, value)
		}
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func notaloneSameInstance(a, b syscall.Stat_t) bool {
	return a.Ino == b.Ino && a.Birthtimespec == b.Birthtimespec && (a.Nlink == b.Nlink || a.Mode&syscall.S_IFMT == syscall.S_IFDIR) && a.Mode&syscall.S_IFMT == b.Mode&syscall.S_IFMT
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
	if count, err := guard.waitEvents(guard.queue, []syscall.Kevent_t{event}, events[:], &zero); err != nil || count != 0 {
		return errors.New("source_guard_watch_failed")
	}
	return nil
}

func (guard *notaloneSourceGuard) waitEvents(queue int, changes, events []syscall.Kevent_t, timeout *syscall.Timespec) (int, error) {
	// Go 运行时抢占及其他信号可打断 kevent；EINTR 不代表来源实例变化。
	for {
		count, err := guard.kevent(queue, changes, events, timeout)
		if err != syscall.EINTR {
			return count, err
		}
	}
}

func (guard *notaloneSourceGuard) checkEvents() bool {
	var events [32]syscall.Kevent_t
	zero := syscall.Timespec{}
	directoryChanged := false
	for attempt := 0; attempt < 64; attempt++ {
		count, err := guard.waitEvents(guard.queue, nil, events[:], &zero)
		if err != nil {
			return false
		}
		if count == 0 {
			return !directoryChanged || guard.checkIdentities()
		}
		for _, event := range events[:count] {
			if !guard.isDirectoryWrite(event) {
				return false
			}
			directoryChanged = true
		}
	}
	return false
}

func (guard *notaloneSourceGuard) isDirectoryWrite(event syscall.Kevent_t) bool {
	if event.Filter != syscall.EVFILT_VNODE || event.Flags&(syscall.EV_ERROR|syscall.EV_EOF) != 0 || event.Fflags != syscall.NOTE_WRITE {
		return false
	}
	for _, watched := range guard.watches {
		if watched.directory && event.Ident == uint64(watched.fd) {
			return true
		}
	}
	return false
}

// 调用者持有 mu；只核对已选来源，新增或缺少消息分片同样失效。
func (guard *notaloneSourceGuard) checkIdentities() bool {
	for _, identity := range guard.processes {
		current, err := readNotaloneProcessIdentity(identity.pid, identity.path)
		if err != nil || current != identity {
			return false
		}
	}
	for _, watched := range guard.watches {
		var pathStat, openStat syscall.Stat_t
		if syscall.Lstat(watched.path, &pathStat) != nil || syscall.Fstat(watched.fd, &openStat) != nil || !notaloneSameInstance(watched.stat, pathStat) || !notaloneSameInstance(watched.stat, openStat) {
			return false
		}
	}
	if guard.messageFiles != nil {
		entries, err := os.ReadDir(filepath.Dir(guard.messageFiles[0]))
		if err != nil {
			return false
		}
		current := []string{}
		for _, entry := range entries {
			if msgShardRE.MatchString(entry.Name()) {
				current = append(current, filepath.Join(filepath.Dir(guard.messageFiles[0]), entry.Name()))
			}
		}
		sort.Strings(current)
		if len(current) != len(guard.messageFiles) {
			return false
		}
		for index := range current {
			if current[index] != guard.messageFiles[index] {
				return false
			}
		}
	}
	return true
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
	valid := guard.checkEvents() && guard.checkIdentities()
	if !valid || !guard.checkEvents() {
		guard.invalid = true
		guard.lostOnce.Do(func() { close(guard.lost) })
		return errors.New("source_guard_changed")
	}
	return nil
}

// 持续监听；目录写入仅触发身份复核，来源实例事件和未知事件立即失效。
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
	if count, err := guard.waitEvents(guard.queue, []syscall.Kevent_t{user}, nil, &zero); err != nil || count != 0 {
		return errors.New("source_guard_watch_failed")
	}
	guard.monitoring = true
	guard.monitorDone = make(chan struct{})
	queue := guard.queue
	go func() {
		defer close(guard.monitorDone)
		var events [1]syscall.Kevent_t
		for {
			count, err := guard.waitEvents(queue, nil, events[:], nil)
			guard.mu.Lock()
			if guard.closed {
				guard.mu.Unlock()
				return
			}
			valid := err == nil && count == 1 && guard.isDirectoryWrite(events[0]) && guard.checkIdentities() && guard.checkEvents()
			if !valid {
				guard.invalid = true
				guard.lostOnce.Do(func() { close(guard.lost) })
				guard.mu.Unlock()
				return
			}
			guard.mu.Unlock()
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
			return notaloneAliasedFingerprint(notaloneSourceFingerprint([]notaloneWatchedSource{watched}), notaloneSourceIdentityAliases), nil
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
		_, err := guard.waitEvents(guard.queue, []syscall.Kevent_t{wake}, nil, &zero)
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
