package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

const notaloneLockProbeEnv = "NOTALONE_LOCK_PROBE_SHM"

// 子进程探针：只读打开 -shm，查询其他进程是否持有 SQLite 的共享内存锁字节（WAL 锁 120–127 与 DMS 128）。
// 未设置环境变量时直接返回，不属于普通测试。
func TestNotAloneLockProbeHelper(t *testing.T) {
	path := os.Getenv(notaloneLockProbeEnv)
	if path == "" {
		return
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY, 0)
	if err != nil {
		fmt.Printf("PROBE error=%v\n", err)
		return
	}
	defer syscall.Close(fd)
	lock := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Start: 120, Len: 9}
	if err := syscall.FcntlFlock(uintptr(fd), syscall.F_GETLK, &lock); err != nil {
		fmt.Printf("PROBE error=%v\n", err)
		return
	}
	if lock.Type == syscall.F_UNLCK {
		fmt.Println("PROBE unlocked")
		return
	}
	fmt.Printf("PROBE held pid=%d\n", lock.Pid)
}

func notaloneProbeSHMLocks(t *testing.T, shm string) string {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestNotAloneLockProbeHelper$")
	command.Env = append(os.Environ(), notaloneLockProbeEnv+"="+shm)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("锁探针失败: %v", err)
	}
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "PROBE ") {
			return strings.TrimPrefix(line, "PROBE ")
		}
	}
	t.Fatalf("锁探针无结果: %s", output)
	return ""
}

// 原始页分析读取 db／-wal／-shm 时，不得因关闭自己的额外句柄而丢掉 SQLite 连接持有的 POSIX 锁：
// macOS 上同一进程对同一文件的任一句柄关闭，都会释放该进程在此文件上的全部劝告锁，
// 使共享内存的存活标记（DMS）和固定快照的读标记失效，其他进程可能把仍在使用的 -shm 当作无人使用而重新初始化。
func TestNotAloneDeltaKeepsSQLiteSharedMemoryLocksWhileSnapshotOpen(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	h.certify = notaloneSyntheticTailCertification
	h.checkpointDirectory = t.TempDir()
	if err := os.Chmod(h.checkpointDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	shard := filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db")
	writer, err := wcdb.OpenWithKeyMapWritable(shard, h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	table := quoteIdent("Msg_" + talkerHash("friend-a"))
	if err = writer.Exec("PRAGMA journal_mode=WAL;BEGIN"); err != nil {
		t.Fatal(err)
	}
	for id := 2; id <= 50; id++ {
		if err = writer.Exec(fmt.Sprintf("INSERT INTO %s(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(%d,0,1,1,1700000000,0,'x')", table, id)); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Exec("COMMIT"); err != nil {
		t.Fatal(err)
	}
	shm := shard + "-shm"
	if _, err = os.Stat(shm); err != nil {
		t.Fatalf("合成来源缺少 -shm，无法验证锁: %v", err)
	}
	if got := notaloneProbeSHMLocks(t, shm); !strings.HasPrefix(got, "held pid="+fmt.Sprint(os.Getpid())) {
		t.Fatalf("前置条件不成立：写连接应持有共享内存锁，实际 %s", got)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := value.(notaloneSnapshotTarget); !ok || h.snapshot == nil || len(h.snapshot.deltaStates) == 0 {
		t.Fatal("快照未执行原始页分析，测试没有覆盖目标路径")
	}
	if got := notaloneProbeSHMLocks(t, shm); !strings.HasPrefix(got, "held pid="+fmt.Sprint(os.Getpid())) {
		t.Fatalf("快照存续期间 SQLite 共享内存锁丢失: %s", got)
	}
}
