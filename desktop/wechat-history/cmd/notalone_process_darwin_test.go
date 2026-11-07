//go:build darwin

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestNotaloneSessionKeepsSourceProcessGuardBetweenSnapshots(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	child := exec.Command("/bin/cat")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = child.Process.Kill(); _ = child.Wait() })
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		return readNotaloneProcessIdentity(child.Process.Pid, "/bin/cat")
	}
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	target, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.Operation = "page"
	r.Target = target.(notaloneSnapshotTarget).Descriptor
	if _, err = h.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if err = input.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.guardLost:
	case <-time.After(3 * time.Second):
		t.Fatal("固定快照结束后未继续监听来源进程")
	}
	r.Operation = "target"
	r.Target = ""
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
		t.Fatalf("进程退出后重新读取未拒绝: %v", err)
	}
}

func TestNotaloneSourceProcessIdentityRejectsWrongPathAndStartTime(t *testing.T) {
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = readNotaloneProcessIdentity(os.Getpid(), "/not-the-source"); err == nil {
		t.Fatal("未拒绝错误进程路径")
	}
	identity, err := readNotaloneProcessIdentity(os.Getpid(), path)
	if err != nil {
		t.Fatal(err)
	}
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	identity.startMicros++
	if guard.WatchProcess(identity) == nil {
		t.Fatal("相同PID的旧启动身份被接受")
	}
}

func TestNotaloneSourceProcessRegistrationAllowsPendingSidecarWrite(t *testing.T) {
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := readNotaloneProcessIdentity(os.Getpid(), path)
	if err != nil {
		t.Fatal(err)
	}
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	if err := os.WriteFile(filepath.Join(directory, "message_0.db-shm"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := guard.WatchProcess(identity); err != nil {
		t.Fatalf("注册存活进程时把正常旁车事件误判为失证: %v", err)
	}
	if err := guard.Check(); err != nil {
		t.Fatalf("进程注册后同一来源实例失效: %v", err)
	}
}

func TestNotaloneSourceProcessRegistrationRejectsPendingSourceReplacement(t *testing.T) {
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := readNotaloneProcessIdentity(os.Getpid(), path)
	if err != nil {
		t.Fatal(err)
	}
	directory, file := notaloneGuardFixture(t)
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	if err := os.Rename(file, filepath.Join(directory, "replaced.db")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("新实例"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := guard.WatchProcess(identity); err == nil {
		t.Fatal("登记存活进程时未拒绝来源文件替换")
	}
}

func TestNotaloneSourceGuardStopsWhenSourceProcessExits(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	child := exec.Command("/bin/cat")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = input.Close(); _ = child.Process.Kill(); _ = child.Wait() })
	identity, err := readNotaloneProcessIdentity(child.Process.Pid, "/bin/cat")
	if err != nil {
		t.Fatal(err)
	}
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guard.Close() })
	if err = guard.WatchProcess(identity); err != nil {
		t.Fatal(err)
	}
	if err = guard.Check(); err != nil {
		t.Fatal(err)
	}
	if err = guard.StartMonitor(); err != nil {
		t.Fatal(err)
	}
	if err = input.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-guard.Lost():
	case <-time.After(3 * time.Second):
		t.Fatal("来源进程退出后守卫仍保持有效")
	}
	if guard.Check() == nil {
		t.Fatal("来源进程退出未锁存失证状态")
	}
}
