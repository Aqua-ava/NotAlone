//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notaloneGuardFixture(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	file := filepath.Join(directory, "message_0.db")
	if err := os.WriteFile(file, []byte("合成文件"), 0600); err != nil {
		t.Fatal(err)
	}
	return directory, file
}

func TestNotaloneGuardAllowsExistingContentWrites(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	wal := filepath.Join(directory, "message_0.db-wal")
	if err := os.WriteFile(wal, nil, 0600); err != nil {
		t.Fatal(err)
	}
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	fingerprint := guard.Fingerprint()
	if len(fingerprint) != 64 || strings.Contains(fingerprint, directory) {
		t.Fatal("实例指纹不是不透明摘要")
	}
	for _, target := range []string{file, wal} {
		if err := os.WriteFile(target, []byte("合成提交"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := guard.Check(); err != nil || guard.Fingerprint() != fingerprint {
		t.Fatalf("已有文件的正常提交被误判为换代: %v", err)
	}
}

func TestNotaloneGuardAllowsSQLiteSidecarCreateAndRemove(t *testing.T) {
	library := os.Getenv("NOTALONE_TEST_WCDB")
	if library == "" {
		t.Skip("未指定隔离测试使用的 WCDB 制品")
	}
	if err := wcdb.BootstrapBounded(library); err != nil {
		t.Fatal(err)
	}

	directory := t.TempDir()
	file := filepath.Join(directory, "message_0.db")
	database, err := wcdb.OpenPlain(file, true)
	if err != nil {
		t.Fatal(err)
	}
	if rows, err := database.Query("PRAGMA journal_mode=WAL"); err != nil || len(rows) != 1 || rows[0]["journal_mode"] != "wal" {
		database.Close()
		t.Fatalf("合成数据库未进入WAL模式: rows=%v err=%v", rows, err)
	}
	if err := database.Exec("CREATE TABLE sample(value TEXT)"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	database.Close()

	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	monitor, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer monitor.Close()
	if err := monitor.StartMonitor(); err != nil {
		t.Fatal(err)
	}

	database, err = wcdb.OpenPlain(file, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Exec("INSERT INTO sample(value) VALUES('synthetic')"); err != nil {
		database.Close()
		t.Fatal(err)
	}
	for _, sidecar := range []string{file + "-wal", file + "-shm"} {
		if _, err := os.Stat(sidecar); err != nil {
			database.Close()
			t.Fatalf("SQLite未创建预期旁车文件: %v", err)
		}
	}
	if err := guard.Check(); err != nil {
		database.Close()
		t.Fatalf("SQLite创建WAL/SHM旁车后来源守卫失效: %v", err)
	}
	assertNotaloneGuardMonitorHealthy(t, monitor)
	database.Close()
	for _, sidecar := range []string{file + "-wal", file + "-shm"} {
		if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
			t.Fatalf("SQLite关闭后仍保留旁车文件: path=%q err=%v", filepath.Base(sidecar), err)
		}
	}
	if err := guard.Check(); err != nil {
		t.Fatalf("SQLite删除WAL/SHM旁车后来源守卫失效: %v", err)
	}
	assertNotaloneGuardMonitorHealthy(t, monitor)
}

func assertNotaloneGuardMonitorHealthy(t *testing.T, monitor *notaloneSourceGuard) {
	t.Helper()
	select {
	case <-monitor.Lost():
		t.Fatal("SQLite WAL/SHM 旁车生命周期使持续监听失效")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestNotaloneGuardMonitorAllowsSidecarsAndRejectsNewShard(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	if err := guard.StartMonitor(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(file+suffix, []byte("合成旁车"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	assertNotaloneGuardMonitorHealthy(t, guard)
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(file + suffix); err != nil {
			t.Fatal(err)
		}
	}
	assertNotaloneGuardMonitorHealthy(t, guard)
	if err := os.WriteFile(filepath.Join(directory, "message_1.db"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-guard.Lost():
	case <-time.After(2 * time.Second):
		t.Fatal("持续监听未拒绝新增消息分片")
	}
	if err := guard.Check(); err == nil {
		t.Fatal("持续监听失效状态未锁存")
	}
}

func TestNotaloneGuardFingerprintIgnoresSidecarRoster(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	before, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer before.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(file+suffix, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	after, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	if before.Fingerprint() != after.Fingerprint() {
		t.Fatal("旁车名单改变了同一目录和消息文件的来源指纹")
	}
}

func TestNotaloneGuardCheckRetriesInterruptedEventWait(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	interrupted := false
	guard.kevent = func(queue int, changes, events []syscall.Kevent_t, timeout *syscall.Timespec) (int, error) {
		if !interrupted {
			interrupted = true
			return -1, syscall.EINTR
		}
		return syscall.Kevent(queue, changes, events, timeout)
	}
	if err := guard.Check(); err != nil {
		t.Fatalf("信号打断非阻塞事件核验使同一来源失效: %v", err)
	}
	if !interrupted {
		t.Fatal("未覆盖被信号打断的原生等待")
	}
}

func TestNotaloneGuardMonitorRetriesInterruptedEventWait(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	var interrupted atomic.Bool
	injected := make(chan struct{})
	guard.kevent = func(queue int, changes, events []syscall.Kevent_t, timeout *syscall.Timespec) (int, error) {
		if timeout == nil && len(changes) == 0 && interrupted.CompareAndSwap(false, true) {
			close(injected)
			return -1, syscall.EINTR
		}
		return syscall.Kevent(queue, changes, events, timeout)
	}
	if err := guard.StartMonitor(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-injected:
	case <-time.After(time.Second):
		t.Fatal("持续监听未执行原生等待")
	}
	select {
	case <-guard.Lost():
		t.Fatal("信号打断持续监听使同一来源失效")
	case <-time.After(100 * time.Millisecond):
	}
	if err := os.WriteFile(filepath.Join(directory, "message_1.db"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-guard.Lost():
	case <-time.After(2 * time.Second):
		t.Fatal("信号重试后持续监听未拒绝新增分片")
	}
	if err := guard.Check(); err == nil {
		t.Fatal("来源变化未锁存")
	}
}

func TestNotaloneGuardRejectsEventWaitErrors(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	guard.kevent = func(int, []syscall.Kevent_t, []syscall.Kevent_t, *syscall.Timespec) (int, error) {
		return -1, syscall.EBADF
	}
	if err := guard.Check(); err == nil {
		t.Fatal("原生事件等待异常未使守卫失效")
	}
}

func TestNotaloneGuardCannotDetectTransientShardCreation(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()

	// kqueue 只报告目录变动，不包含文件名；短暂新增后删除与旁车生命周期无法区分。
	added := filepath.Join(directory, "message_1.db")
	if err := os.WriteFile(added, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(added); err != nil {
		t.Fatal(err)
	}
	if err := guard.Check(); err != nil {
		t.Fatalf("当前分片集合未变化，不应将无法区分的瞬态目录写入判为失效: %v", err)
	}
}

func TestNotaloneGuardRejectsNamespaceChanges(t *testing.T) {
	for _, change := range []string{"replace", "replace_and_restore", "add", "add_symlink", "add_directory", "remove", "directory_replace", "directory_replace_and_restore"} {
		t.Run(change, func(t *testing.T) {
			directory, file := notaloneGuardFixture(t)
			guard, err := newNotaloneSourceGuard(directory, []string{file})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = guard.Close() })
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch change {
			case "replace", "replace_and_restore":
				old := filepath.Join(directory, "old.db")
				must(os.Rename(file, old))
				must(os.WriteFile(file, []byte("新实例"), 0600))
				if change == "replace_and_restore" {
					must(os.Remove(file))
					must(os.Rename(old, file))
				}
			case "add":
				added := filepath.Join(directory, "message_1.db")
				must(os.WriteFile(added, nil, 0600))
			case "add_symlink":
				must(os.Symlink(file, filepath.Join(directory, "message_1.db")))
			case "add_directory":
				must(os.Mkdir(filepath.Join(directory, "message_1.db"), 0700))
			case "remove":
				must(os.Remove(file))
			case "directory_replace", "directory_replace_and_restore":
				must(os.Rename(directory, directory+"-old"))
				t.Cleanup(func() { _ = os.RemoveAll(directory + "-old") })
				must(os.Mkdir(directory, 0700))
				must(os.WriteFile(file, nil, 0600))
				if change == "directory_replace_and_restore" {
					must(os.RemoveAll(directory))
					must(os.Rename(directory+"-old", directory))
				}
			}
			if err := guard.Check(); err == nil {
				t.Fatal("命名空间变化未使守卫失效")
			}
			if err := guard.Check(); err == nil {
				t.Fatal("失效状态未锁存")
			}
		})
	}
}

func TestNotaloneGuardRejectsLinksAndClosesHandles(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	countFD := func() int {
		t.Helper()
		directory, err := os.Open("/dev/fd")
		if err != nil {
			t.Fatal(err)
		}
		defer directory.Close()
		entries, err := directory.Readdirnames(-1)
		if err != nil {
			t.Fatal(err)
		}
		return len(entries)
	}
	before := countFD()
	link := filepath.Join(directory, "linked.db")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if guard, err := newNotaloneSourceGuard(directory, []string{link}); err == nil {
		_ = guard.Close()
		t.Fatal("未拒绝符号链接")
	}
	if guard, err := newNotaloneSourceGuard(directory, []string{directory}); err == nil {
		_ = guard.Close()
		t.Fatal("未拒绝非普通文件")
	}
	directoryLink := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(directory, directoryLink); err != nil {
		t.Fatal(err)
	}
	if guard, err := newNotaloneSourceGuard(directoryLink, []string{filepath.Join(directoryLink, filepath.Base(file))}); err == nil {
		_ = guard.Close()
		t.Fatal("未拒绝符号链接目录")
	}
	for i := 0; i < 30; i++ {
		guard, err := newNotaloneSourceGuard(directory, []string{file})
		if err != nil {
			t.Fatal(err)
		}
		if err := guard.Close(); err != nil {
			t.Fatal(err)
		}
		if err := guard.Close(); err != nil {
			t.Fatal("重复关闭失败")
		}
		if err := guard.Check(); err == nil {
			t.Fatal("关闭后仍可使用守卫")
		}
	}
	if after := countFD(); after != before {
		t.Fatalf("守卫泄漏句柄: before=%d after=%d", before, after)
	}
}

func TestNotaloneGuardMonitorStopsBeforeDescriptorReuse(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	for i := 0; i < 30; i++ {
		guard, err := newNotaloneSourceGuard(directory, []string{file})
		if err != nil {
			t.Fatal(err)
		}
		if err = guard.StartMonitor(); err != nil {
			t.Fatal(err)
		}
		if err = guard.Close(); err != nil {
			t.Fatal(err)
		}
		if err = guard.Close(); err != nil {
			t.Fatal(err)
		}
	}
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatalf("先前监听未退出导致新守卫失败: %v", err)
	}
	defer guard.Close()
	if err = guard.Check(); err != nil {
		t.Fatal(err)
	}
}

func TestNotaloneGuardFileFingerprintIgnoresOtherShards(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	first, err := guard.FileFingerprint(file)
	if err != nil || len(first) != 64 {
		t.Fatalf("文件实例摘要不可用: %v", err)
	}
	other := filepath.Join(directory, "message_1.db")
	if _, err := guard.FileFingerprint(other); err == nil {
		t.Fatal("允许白名单以外的路径")
	}
	if err := os.WriteFile(other, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := guard.Check(); err == nil {
		t.Fatal("新增分片未使原守卫失效")
	}
	next, err := newNotaloneSourceGuard(directory, []string{other, file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = next.Close() })
	second, err := next.FileFingerprint(file)
	if err != nil || second != first {
		t.Fatalf("另一分片改变原分片身份: %v", err)
	}
}
