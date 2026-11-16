package wcdb

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

const sourceProbeEnv = "NOTALONE_SOURCE_SHM_PROBE"

type sourceOriginalProbe struct {
	OpenFlags       []int32 `json:"openFlags"`
	DescriptorFlags []int32 `json:"descriptorFlags"`
	Truncations     []int64 `json:"truncations"`
	Writes          int     `json:"writes"`
	Unlinks         int     `json:"unlinks"`
	MmapProtections []int32 `json:"mmapProtections"`
}

type sourceSHMProbe struct {
	Sources     map[string]*sourceOriginalProbe `json:"sources"`
	Temporary   bool                            `json:"temporary"`
	Error       string                          `json:"error,omitempty"`
	Values      []int64                         `json:"values"`
	OpenFlags   []int32                         `json:"openFlags"`
	Truncations []int64                         `json:"truncations"`
	Unlinks     int                             `json:"unlinks"`
	DMSHolder   int32                           `json:"dmsHolder"`
}

// 仅在隔离子进程中拦截固定 WCDB Unix VFS 的真实系统调用。
// sqlite3_vfs 的 v3 ABI 来自锁定 SQLCipher 的 sqlite3.h；本测试只在 macOS 运行。
type sourceProbeVFS struct {
	Version, FileSize, MaxPath                   int32
	Next, Name, Data                             uintptr
	Methods                                      [13]uintptr
	SetSystemCall, GetSystemCall, NextSystemCall uintptr
}

func sourceProbeCString(p uintptr) string {
	if p == 0 {
		return ""
	}
	for n := 0; n < 4096; n++ {
		if *(*byte)(unsafe.Pointer(p + uintptr(n))) == 0 {
			return string(unsafe.Slice((*byte)(unsafe.Pointer(p)), n))
		}
	}
	return ""
}

func sourceProbeHooks(path string, result *sourceSHMProbe) (func(), error) {
	boundedBootstrap.Lock()
	library := boundedBootstrap.path
	boundedBootstrap.Unlock()
	handle, err := loadLibrary(library)
	if err != nil {
		return nil, err
	}
	var find func(uintptr) uintptr
	purego.RegisterLibFunc(&find, handle, "sqlite3_vfs_find")
	p := find(0)
	if p == 0 {
		return nil, fmt.Errorf("probe_vfs_missing")
	}
	v := (*sourceProbeVFS)(unsafe.Pointer(p))
	if v.Version < 3 {
		return nil, fmt.Errorf("probe_vfs_version")
	}
	var get func(uintptr, string) uintptr
	var set func(uintptr, string, uintptr) int32
	purego.RegisterFunc(&get, v.GetSystemCall)
	purego.RegisterFunc(&set, v.SetSystemCall)
	result.Sources = map[string]*sourceOriginalProbe{"db": {}, "wal": {}, "shm": {}}
	classify := func(name string) string {
		switch name {
		case path:
			return "db"
		case path + "-wal":
			return "wal"
		case path + "-shm":
			return "shm"
		}
		return ""
	}
	fds := map[int32]string{}
	installed := []string{}
	install := func(name string, callback uintptr) error {
		if set(p, name, callback) != SQLITE_OK {
			return fmt.Errorf("probe_hook_failed:%s", name)
		}
		installed = append(installed, name)
		return nil
	}
	var open func(uintptr, int32, uint32) int32
	purego.RegisterFunc(&open, get(p, "open"))
	if err = install("open", purego.NewCallback(func(name uintptr, flags int32, mode uint32) int32 {
		fd := open(name, flags, mode)
		kind := classify(sourceProbeCString(name))
		if kind != "" {
			result.Sources[kind].OpenFlags = append(result.Sources[kind].OpenFlags, flags)
			if kind == "shm" {
				result.OpenFlags = append(result.OpenFlags, flags)
			}
			if fd >= 0 {
				fds[fd] = kind
			}
		}
		return fd
	})); err != nil {
		return nil, err
	}
	var closeFD func(int32) int32
	purego.RegisterFunc(&closeFD, get(p, "close"))
	if err = install("close", purego.NewCallback(func(fd int32) int32 { rc := closeFD(fd); delete(fds, fd); return rc })); err != nil {
		return nil, err
	}
	var truncate func(int32, int64) int32
	purego.RegisterFunc(&truncate, get(p, "ftruncate"))
	if err = install("ftruncate", purego.NewCallback(func(fd int32, size int64) int32 {
		if kind := fds[fd]; kind != "" {
			result.Sources[kind].Truncations = append(result.Sources[kind].Truncations, size)
			if kind == "shm" {
				result.Truncations = append(result.Truncations, size)
			}
		}
		return truncate(fd, size)
	})); err != nil {
		return nil, err
	}
	var unlink func(uintptr) int32
	purego.RegisterFunc(&unlink, get(p, "unlink"))
	if err = install("unlink", purego.NewCallback(func(name uintptr) int32 {
		if kind := classify(sourceProbeCString(name)); kind != "" {
			result.Sources[kind].Unlinks++
			if kind == "shm" {
				result.Unlinks++
			}
		}
		return unlink(name)
	})); err != nil {
		return nil, err
	}
	if pointer := get(p, "write"); pointer != 0 {
		var write func(int32, uintptr, uintptr) int64
		purego.RegisterFunc(&write, pointer)
		if err = install("write", purego.NewCallback(func(fd int32, buffer uintptr, size uintptr) int64 {
			if kind := fds[fd]; kind != "" {
				result.Sources[kind].Writes++
			}
			return write(fd, buffer, size)
		})); err != nil {
			return nil, err
		}
	}
	for _, name := range []string{"pwrite", "pwrite64"} {
		pointer := get(p, name)
		if pointer == 0 {
			continue
		}
		var write func(int32, uintptr, uintptr, int64) int64
		purego.RegisterFunc(&write, pointer)
		if err = install(name, purego.NewCallback(func(fd int32, buffer uintptr, size uintptr, offset int64) int64 {
			if kind := fds[fd]; kind != "" {
				result.Sources[kind].Writes++
			}
			return write(fd, buffer, size, offset)
		})); err != nil {
			return nil, err
		}
	}
	if pointer := get(p, "mmap"); pointer != 0 {
		var mmap func(uintptr, uintptr, int32, int32, int32, int64) uintptr
		purego.RegisterFunc(&mmap, pointer)
		if err = install("mmap", purego.NewCallback(func(address uintptr, size uintptr, protection int32, flags int32, fd int32, offset int64) uintptr {
			if kind := fds[fd]; kind != "" {
				result.Sources[kind].MmapProtections = append(result.Sources[kind].MmapProtections, protection)
			}
			return mmap(address, size, protection, flags, fd, offset)
		})); err != nil {
			return nil, err
		}
	}
	return func() {
		for _, name := range installed {
			_ = set(p, name, 0)
		}
		_ = purego.Dlclose(handle)
	}, nil
}

func sourceProbeDescriptorFlags(path string, result *sourceSHMProbe) error {
	directory, err := os.Open("/dev/fd")
	if err != nil {
		return err
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return err
	}
	identities := map[uint64]string{}
	for kind, suffix := range map[string]string{"db": "", "wal": "-wal", "shm": "-shm"} {
		var st syscall.Stat_t
		if syscall.Stat(path+suffix, &st) == nil {
			identities[st.Ino] = kind
		}
	}
	for _, name := range names {
		fd, err := strconv.Atoi(name)
		if err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil {
			continue
		}
		kind := identities[st.Ino]
		if kind == "" {
			continue
		}
		flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFL, 0)
		if errno != 0 {
			return errno
		}
		result.Sources[kind].DescriptorFlags = append(result.Sources[kind].DescriptorFlags, int32(flags))
	}
	return nil
}

func sourceProbeDMS(path string) (int32, error) {
	fd, err := syscall.Open(path+"-shm", syscall.O_RDONLY, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(fd)
	lock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Start: 128, Len: 1}
	if err = syscall.FcntlFlock(uintptr(fd), syscall.F_GETLK, &lock); err != nil {
		return 0, err
	}
	if lock.Type == syscall.F_UNLCK {
		return 0, nil
	}
	return lock.Pid, nil
}

func TestNotAloneSourceSHMProbe(t *testing.T) {
	path := os.Getenv(sourceProbeEnv)
	if path == "" {
		return
	}
	result := sourceSHMProbe{}
	run := func() error {
		if err := BootstrapBounded(os.Getenv("NOTALONE_TEST_WCDB")); err != nil {
			return err
		}
		result.DMSHolder, _ = sourceProbeDMS(path)
		cleanup, err := sourceProbeHooks(path, &result)
		if err != nil {
			return err
		}
		defer cleanup()
		var db *DB
		if os.Getenv("NOTALONE_SOURCE_ENCRYPTED") == "1" {
			db, err = OpenWithKeyMap(path, map[string]string{strings.Repeat("22", 16): strings.Repeat("11", 32)})
		} else {
			db, err = OpenPlain(path, false)
		}
		if err != nil {
			return err
		}
		defer db.Close()
		holding := os.Getenv("NOTALONE_SOURCE_HOLD") == "1"
		if holding {
			if err = db.Exec("BEGIN"); err != nil {
				return err
			}
		}
		rows, err := db.QueryBounded(context.Background(), 10, "SELECT n FROM t ORDER BY n")
		if err != nil {
			return err
		}
		for _, row := range rows {
			result.Values = append(result.Values, row["n"].(int64))
		}
		if err = sourceProbeDescriptorFlags(path, &result); err != nil {
			return err
		}
		if holding {
			if err = json.NewEncoder(os.Stdout).Encode(result); err != nil {
				return err
			}
			input := bufio.NewScanner(os.Stdin)
			if !input.Scan() {
				return fmt.Errorf("probe_control_closed")
			}
			rows, err = db.QueryBounded(context.Background(), 10, "SELECT n FROM t ORDER BY n")
			if err != nil {
				return err
			}
			result.Values = nil
			for _, row := range rows {
				result.Values = append(result.Values, row["n"].(int64))
			}
			if err = db.Exec("ROLLBACK"); err != nil {
				return err
			}
		}
		return nil
	}
	if err := run(); err != nil {
		result.Error = err.Error()
		result.Temporary = IsSourceTemporarilyUnavailable(err)
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
	os.Exit(0)
}

func sourceSHMReader(t *testing.T, path string, encrypted bool) sourceSHMProbe {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestNotAloneSourceSHMProbe$")
	cmd.Env = append(os.Environ(), sourceProbeEnv+"="+path, fmt.Sprintf("NOTALONE_SOURCE_ENCRYPTED=%d", map[bool]int{false: 0, true: 1}[encrypted]))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("隔离读取进程失败: %v", err)
	}
	var result sourceSHMProbe
	if err = json.Unmarshal(out, &result); err != nil {
		t.Fatalf("隔离观测响应无效: %v: %s", err, out)
	}
	return result
}

func sourceSHMWriter(t *testing.T, path string, encrypted bool) *DB {
	t.Helper()
	library := os.Getenv("NOTALONE_TEST_WCDB")
	if library == "" {
		t.Skip("未指定固定 WCDB 合成测试库")
	}
	if err := BootstrapBounded(library); err != nil {
		t.Fatal(err)
	}
	var db *DB
	var err error
	if encrypted {
		if err = os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		db, err = OpenWithEncKeyWritable(path, strings.Repeat("11", 32), strings.Repeat("22", 16))
	} else {
		db, err = OpenPlain(path, true)
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	for _, query := range []string{"PRAGMA journal_mode=WAL", "PRAGMA wal_autocheckpoint=0", "CREATE TABLE t(n INTEGER)", "INSERT INTO t VALUES(1)", "BEGIN", "SELECT * FROM t"} {
		if err = db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestNotAloneSourceNeverWritesSharedMemoryWhenHolderLosesDMS(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(fmt.Sprintf("encrypted=%v", encrypted), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "合成 #?% 数据.db")
			_ = sourceSHMWriter(t, path, encrypted)
			// 合成持有者额外打开再关闭自己的 SHM FD，重现已证实的进程级 DMS 丢失。
			extra, err := os.Open(path + "-shm")
			if err != nil {
				t.Fatal(err)
			}
			_ = extra.Close()
			result := sourceSHMReader(t, path, encrypted)
			if result.Error != "" || len(result.Values) != 1 || result.Values[0] != 1 {
				t.Fatalf("未读到提交的合成消息: %+v", result)
			}
			if result.DMSHolder != 0 {
				t.Fatalf("实验未成功制造 DMS 丢失: %+v", result)
			}
			if len(result.OpenFlags) == 0 {
				t.Fatal("未捕获原始SHM实际打开")
			}
			for _, flags := range result.OpenFlags {
				if flags&syscall.O_ACCMODE != syscall.O_RDONLY || flags&syscall.O_CREAT != 0 {
					t.Errorf("原始SHM被可写或创建方式打开: flags=%#x", flags)
				}
			}
			t.Logf("实际SHM open=%#v, ftruncate=%v, unlink=%d", result.OpenFlags, result.Truncations, result.Unlinks)
			if result.Unlinks != 0 {
				t.Errorf("读取器删除原始SHM: %v", result)
			}
			if len(result.Truncations) != 0 {
				t.Errorf("读取过程截短原始SHM: %v", result.Truncations)
			}
		})
	}
}

func TestNotAloneSourceMissingSHMFailsWithoutCreatingOrDeletingSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "缺少SHM ?readonly_shm=0&immutable=1# 合成.db")
	_ = sourceSHMWriter(t, path, false)
	if err := os.Remove(path + "-shm"); err != nil {
		t.Fatal(err)
	}
	result := sourceSHMReader(t, path, false)
	if result.Error == "" || !result.Temporary || len(result.Values) != 0 {
		t.Fatalf("缺失SHM仍读取或接纳了结果: %+v", result)
	}
	for _, flags := range result.OpenFlags {
		if flags&syscall.O_ACCMODE != syscall.O_RDONLY || flags&syscall.O_CREAT != 0 {
			t.Fatalf("缺失SHM回退为可写/创建: %+v", result)
		}
	}
	if len(result.Truncations) != 0 || result.Unlinks != 0 {
		t.Fatalf("失败路径修改了原始SHM: %+v", result)
	}
	if _, err := os.Stat(path + "-shm"); !os.IsNotExist(err) {
		t.Fatalf("失败路径创建了SHM: %v", err)
	}
	t.Logf("缺SHM安全失败: error=%s open=%#v truncate=%v unlink=%d", result.Error, result.OpenFlags, result.Truncations, result.Unlinks)
}

func TestNotAloneDeferredSourceDescriptorsDrainAfterLastConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "句柄生命周期.db")
	_ = sourceSHMWriter(t, path, false)
	countSourceFDs := func() int {
		directory, err := os.Open("/dev/fd")
		if err != nil {
			t.Fatal(err)
		}
		defer directory.Close()
		entries, err := directory.Readdirnames(-1)
		if err != nil {
			t.Fatal(err)
		}
		identities := map[uint64]bool{}
		for _, source := range []string{path, path + "-wal", path + "-shm"} {
			var st syscall.Stat_t
			if syscall.Stat(source, &st) == nil {
				identities[st.Ino] = true
			}
		}
		count := 0
		for _, entry := range entries {
			fd, err := strconv.Atoi(entry)
			if err != nil {
				continue
			}
			var st syscall.Stat_t
			if syscall.Fstat(fd, &st) == nil && identities[st.Ino] {
				count++
			}
		}
		return count
	}
	baseline := -1
	for cycle := 0; cycle < 20; cycle++ {
		first, err := OpenPlain(path, false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = first.QueryBounded(context.Background(), 10, "SELECT * FROM t"); err != nil {
			t.Fatal(err)
		}
		second, err := OpenPlain(path, false)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = second.QueryBounded(context.Background(), 10, "SELECT * FROM t"); err != nil {
			t.Fatal(err)
		}
		extra, err := os.Open(path + "-shm")
		if err != nil {
			t.Fatal(err)
		}
		if err = CloseSourceFile(extra); err != nil {
			t.Fatal(err)
		}
		first.Close()
		if _, err = extra.Stat(); err != nil {
			t.Fatalf("其他源连接活跃时提前关闭额外FD: %v", err)
		}
		second.Close()
		if _, err = extra.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("最后连接退出后FD未排空: %v", err)
		}
		notaloneSourceFiles.Lock()
		active, pending, unknown := notaloneSourceFiles.active, len(notaloneSourceFiles.pending), len(notaloneSourceFiles.unknown)
		notaloneSourceFiles.Unlock()
		if active != 0 || pending != 0 || unknown != 0 {
			t.Fatalf("源句柄未归零: active=%d pending=%d unknown=%d", active, pending, unknown)
		}
		count := countSourceFDs()
		if baseline < 0 {
			baseline = count
		} else if count != baseline {
			t.Fatalf("重复读取源FD持续增长: initial=%d current=%d cycle=%d", baseline, count, cycle)
		}
	}
	t.Logf("20轮后源FD=%d，active/pending/unknown均为0", baseline)
}

func TestNotAloneSourcePreservesSnapshotAcrossCommitCheckpointAndWALReuse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "并发提交与回卷.db")
	writer := sourceSHMWriter(t, path, false)
	if err := writer.Exec("PRAGMA busy_timeout=1"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNotAloneSourceSHMProbe$")
	command.Env = append(os.Environ(), sourceProbeEnv+"="+path, "NOTALONE_SOURCE_HOLD=1")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = input.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	}()
	decoder := json.NewDecoder(output)
	var before, after sourceSHMProbe
	if err = decoder.Decode(&before); err != nil || before.Error != "" || len(before.Values) != 1 {
		t.Fatalf("未建立固定源快照: result=%+v err=%v", before, err)
	}
	if err = writer.Exec("ROLLBACK;INSERT INTO t VALUES(2)"); err != nil {
		t.Fatal(err)
	}
	checkpoint, err := writer.Query("PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil || len(checkpoint) != 1 || checkpoint[0]["busy"] != int64(1) {
		t.Fatalf("活跃读取快照未阻止截断checkpoint: rows=%v err=%v", checkpoint, err)
	}
	if _, err = fmt.Fprintln(input, "next"); err != nil {
		t.Fatal(err)
	}
	if err = decoder.Decode(&after); err != nil {
		t.Fatal(err)
	}
	if err = command.Wait(); err != nil {
		t.Fatal(err)
	}
	if after.Error != "" || len(after.Values) != 1 || after.Values[0] != 1 {
		t.Fatalf("并发提交改变了固定快照: %+v", after)
	}
	for _, flags := range after.OpenFlags {
		if flags&syscall.O_ACCMODE != syscall.O_RDONLY || flags&syscall.O_CREAT != 0 {
			t.Fatalf("并发读取可写SHM: %+v", after)
		}
	}
	if len(after.Truncations) != 0 || after.Unlinks != 0 {
		t.Fatalf("并发读取修改原始SHM: %+v", after)
	}
	checkpoint, err = writer.Query("PRAGMA wal_checkpoint(TRUNCATE)")
	if err != nil || len(checkpoint) != 1 || checkpoint[0]["busy"] != int64(0) {
		t.Fatalf("读者退出后checkpoint未释放: rows=%v err=%v", checkpoint, err)
	}
	if err = writer.Exec("INSERT INTO t VALUES(3)"); err != nil {
		t.Fatal(err)
	}
	fresh := sourceSHMReader(t, path, false)
	if fresh.Error != "" || len(fresh.Values) != 3 || fresh.Values[2] != 3 || len(fresh.Truncations) != 0 || fresh.Unlinks != 0 {
		t.Fatalf("WAL回卷后未读取新提交: %+v", fresh)
	}
	t.Logf("固定快照=%v；提交/checkpoint/WAL回卷后新快照=%v；原SHM截短/删除=0", after.Values, fresh.Values)
}

func TestNotAloneUnrelatedImageGuardsCloseDuringActiveSourceConnection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "合成源.db")
	_ = sourceSHMWriter(t, path, false)
	reader, err := OpenPlain(path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err = reader.QueryBounded(context.Background(), 10, "SELECT * FROM t"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 30; index++ {
		image := filepath.Join(t.TempDir(), fmt.Sprintf("合成图片-%d.png", index))
		if err = os.WriteFile(image, []byte("synthetic-image"), 0600); err != nil {
			t.Fatal(err)
		}
		fd, err := OpenSourceDescriptor(image, syscall.O_EVTONLY)
		if err != nil {
			t.Fatal(err)
		}
		if err = CloseSourceDescriptor(fd); err != nil {
			t.Fatal(err)
		}
		var st syscall.Stat_t
		if err = syscall.Fstat(fd, &st); err != syscall.EBADF {
			t.Fatalf("无关图片守卫在源连接期间继续占用FD: %v", err)
		}
	}
}

func TestNotAloneFailedSQLiteCloseKeepsSourceDescriptorsUntilSuccessfulRetry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "失败关闭.db")
	_ = sourceSHMWriter(t, path, false)
	reader, err := OpenPlain(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reader.QueryBounded(context.Background(), 10, "SELECT * FROM t"); err != nil {
		t.Fatal(err)
	}
	extra, err := os.Open(path + "-shm")
	if err != nil {
		t.Fatal(err)
	}
	if err = CloseSourceFile(extra); err != nil {
		t.Fatal(err)
	}
	original := sqlite3_close_v2
	sqlite3_close_v2 = func(uintptr) int32 { return SQLITE_BUSY }
	reader.Close()
	sqlite3_close_v2 = original
	if _, err = extra.Stat(); err != nil {
		t.Fatalf("原生关闭失败时提前释放源FD: %v", err)
	}
	reader.Close()
	if _, err = extra.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("成功重试关闭后源FD未释放: %v", err)
	}
}

func TestNotAloneAllOriginalFilesOpenReadOnlyWithoutMutation(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(fmt.Sprintf("encrypted=%v", encrypted), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "全部原件 ?#% 中文.db")
			_ = sourceSHMWriter(t, path, encrypted)
			result := sourceSHMReader(t, path, encrypted)
			if result.Error != "" || len(result.Values) != 1 {
				t.Fatalf("读取合成原件失败: %+v", result)
			}
			for _, kind := range []string{"db", "wal", "shm"} {
				probe := result.Sources[kind]
				if probe == nil || len(probe.OpenFlags) == 0 || len(probe.DescriptorFlags) == 0 {
					t.Fatalf("未覆盖%s实际打开/FD: %+v", kind, probe)
				}
				for _, flags := range append(append([]int32{}, probe.OpenFlags...), probe.DescriptorFlags...) {
					if flags&syscall.O_ACCMODE != syscall.O_RDONLY || flags&(syscall.O_CREAT|syscall.O_TRUNC) != 0 {
						t.Errorf("原始%s有可写/创建打开: flags=%#x", kind, flags)
					}
				}
				if probe.Writes != 0 || probe.Unlinks != 0 || len(probe.Truncations) != 0 {
					t.Errorf("原始%s被修改: %+v", kind, probe)
				}
				for _, protection := range probe.MmapProtections {
					if protection&syscall.PROT_WRITE != 0 {
						t.Errorf("原始%s存在可写映射: prot=%#x", kind, protection)
					}
				}
				t.Logf("%s open=%#v fd=%#v mmap=%#v writes=%d truncate=%v unlink=%d", kind, probe.OpenFlags, probe.DescriptorFlags, probe.MmapProtections, probe.Writes, probe.Truncations, probe.Unlinks)
			}
		})
	}
}

func TestNotAloneSourceVFSReportsReadOnlyAndRejectsOriginalDeletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "原件边界.db")
	_ = sourceSHMWriter(t, path, false)
	reader, err := OpenPlain(path, false)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if _, err = reader.QueryBounded(context.Background(), 10, "SELECT * FROM t"); err != nil {
		t.Fatal(err)
	}
	boundedBootstrap.Lock()
	library := boundedBootstrap.path
	boundedBootstrap.Unlock()
	handle, err := loadLibrary(library)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(handle)
	var find func(uintptr) uintptr
	var allocate func(uint64) uintptr
	var free func(uintptr)
	purego.RegisterLibFunc(&find, handle, "sqlite3_vfs_find")
	purego.RegisterLibFunc(&allocate, handle, "sqlite3_malloc64")
	purego.RegisterLibFunc(&free, handle, "sqlite3_free")
	if find(0) != notaloneSourceVFS.parent {
		t.Fatal("源VFS改变了默认写者VFS")
	}
	v := (*notaloneSQLiteVFS)(unsafe.Pointer(notaloneSourceVFS.allocation))
	var open func(uintptr, uintptr, uintptr, int32, uintptr) int32
	var deleteFile func(uintptr, uintptr, int32) int32
	purego.RegisterFunc(&open, v.Open)
	purego.RegisterFunc(&deleteFile, v.Delete)
	cString := func(text string) uintptr {
		pointer := allocate(uint64(len(text) + 1))
		if pointer == 0 {
			t.Fatal("合成C字符串分配失败")
		}
		bytes := unsafe.Slice((*byte)(unsafe.Pointer(pointer)), len(text)+1)
		clear(bytes)
		copy(bytes, text)
		t.Cleanup(func() { free(pointer) })
		return pointer
	}
	file := allocate(uint64(v.FileSize) + 8)
	if file == 0 {
		t.Fatal("合成VFS文件分配失败")
	}
	defer free(file)
	clear(unsafe.Slice((*byte)(unsafe.Pointer(file)), int(v.FileSize)+8))
	outFlags := file + uintptr(v.FileSize)
	rc := open(notaloneSourceVFS.allocation, cString(path+"-wal"), file, 0x00080000|SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE, outFlags)
	if rc != SQLITE_OK {
		t.Fatalf("只读WAL打开失败: %d", rc)
	}
	actual := *(*int32)(unsafe.Pointer(outFlags))
	if actual&SQLITE_OPEN_READONLY == 0 || actual&(SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE) != 0 {
		t.Fatalf("SQLite未取得真实WAL只读outFlags: %#x", actual)
	}
	methods := *(*uintptr)(unsafe.Pointer(file))
	var closeFile func(uintptr) int32
	purego.RegisterFunc(&closeFile, *(*uintptr)(unsafe.Pointer(methods + 8)))
	if rc = closeFile(file); rc != SQLITE_OK {
		t.Fatal("只读WAL关闭失败")
	}
	clear(unsafe.Slice((*byte)(unsafe.Pointer(file)), int(v.FileSize)+8))
	missingBase := filepath.Join(t.TempDir(), "缺失日志.db")
	if err = os.WriteFile(missingBase, []byte("synthetic-base"), 0600); err != nil {
		t.Fatal(err)
	}
	rc = open(notaloneSourceVFS.allocation, cString(missingBase+"-wal"), file, 0x00080000|SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE, outFlags)
	if rc == SQLITE_OK || *(*uintptr)(unsafe.Pointer(file)) != 0 {
		t.Fatalf("缺失WAL打开未安全失败或残留pMethods: rc=%d methods=%#x", rc, *(*uintptr)(unsafe.Pointer(file)))
	}
	if _, err = os.Stat(missingBase + "-wal"); !os.IsNotExist(err) {
		t.Fatalf("只读失败路径创建了缺失WAL: %v", err)
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if rc = deleteFile(notaloneSourceVFS.allocation, cString(path+suffix), 0); rc != 8 {
			t.Errorf("原件%s未拒绝删除: rc=%d", suffix, rc)
		}
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err = os.Stat(path + suffix); err != nil {
			t.Fatalf("原件被删除: %s: %v", suffix, err)
		}
	}
	temporary := filepath.Join(t.TempDir(), "临时排序文件")
	if err = os.WriteFile(temporary, []byte("synthetic-temporary"), 0600); err != nil {
		t.Fatal(err)
	}
	if rc = deleteFile(notaloneSourceVFS.allocation, cString(temporary), 0); rc != SQLITE_OK {
		t.Fatalf("临时文件删除行为被改变: rc=%d", rc)
	}
	if _, err = os.Stat(temporary); !os.IsNotExist(err) {
		t.Fatal("临时文件未删除")
	}
}

func TestNotAloneSourceVFSCannotWriteOrTruncateOriginalWAL(t *testing.T) {
	library := os.Getenv("NOTALONE_TEST_WCDB")
	if library == "" {
		t.Skip("需要固定WCDB合成库")
	}
	if err := BootstrapBounded(library); err != nil {
		t.Fatal(err)
	}
	handle, err := loadLibrary(library)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(handle)
	var allocate func(uint64) uintptr
	var free func(uintptr)
	purego.RegisterLibFunc(&allocate, handle, "sqlite3_malloc64")
	purego.RegisterLibFunc(&free, handle, "sqlite3_free")
	path := filepath.Join(t.TempDir(), "只读IO-wal")
	if err = os.WriteFile(strings.TrimSuffix(path, "-wal"), []byte("synthetic-base"), 0600); err != nil {
		t.Fatal(err)
	}
	original := []byte("synthetic-wal-bytes-must-stay")
	if err = os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	v := (*notaloneSQLiteVFS)(unsafe.Pointer(notaloneSourceVFS.allocation))
	file := allocate(uint64(v.FileSize) + uint64(len(path)+1) + 16)
	if file == 0 {
		t.Fatal("分配失败")
	}
	defer free(file)
	clear(unsafe.Slice((*byte)(unsafe.Pointer(file)), int(v.FileSize)+len(path)+17))
	name := file + uintptr(v.FileSize) + 8
	copy(unsafe.Slice((*byte)(unsafe.Pointer(name)), len(path)+1), path)
	outFlags := file + uintptr(v.FileSize)
	var open func(uintptr, uintptr, uintptr, int32, uintptr) int32
	purego.RegisterFunc(&open, v.Open)
	if rc := open(notaloneSourceVFS.allocation, name, file, 0x00080000|SQLITE_OPEN_READWRITE|SQLITE_OPEN_CREATE, outFlags); rc != SQLITE_OK {
		t.Fatalf("打开失败: %d", rc)
	}
	methods := *(*uintptr)(unsafe.Pointer(file))
	var write func(uintptr, uintptr, int32, int64) int32
	var truncate func(uintptr, int64) int32
	var closeFile func(uintptr) int32
	purego.RegisterFunc(&closeFile, *(*uintptr)(unsafe.Pointer(methods + 8)))
	purego.RegisterFunc(&write, *(*uintptr)(unsafe.Pointer(methods + 24)))
	purego.RegisterFunc(&truncate, *(*uintptr)(unsafe.Pointer(methods + 32)))
	if rc := write(file, name, 1, 0); rc == SQLITE_OK {
		t.Error("只读WAL允许xWrite")
	}
	if rc := truncate(file, 3); rc == SQLITE_OK {
		t.Error("只读WAL允许xTruncate")
	}
	if rc := closeFile(file); rc != SQLITE_OK {
		t.Errorf("关闭失败: %d", rc)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(original) {
		t.Fatalf("只读WAL原件被修改: after=%q err=%v", after, err)
	}
}
