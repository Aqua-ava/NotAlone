//go:build darwin

package main

/*
#include <libproc.h>
#include <sys/proc_info.h>

static int notalone_process_identity(int pid, unsigned long long *sec, unsigned long long *usec, char *path) {
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    if (proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE) <= 0) return 0;
    *sec = info.pbi_start_tvsec;
    *usec = info.pbi_start_tvusec;
    return info.pbi_pid == pid && *sec > 0;
}
*/
import "C"

import (
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type notaloneProcessIdentity struct {
	pid          int
	path         string
	startSeconds uint64
	startMicros  uint64
}

func readNotaloneProcessIdentity(pid int, expectedPath string) (notaloneProcessIdentity, error) {
	var seconds, micros C.ulonglong
	var path [C.PROC_PIDPATHINFO_MAXSIZE]C.char
	if pid <= 0 || expectedPath == "" || C.notalone_process_identity(C.int(pid), &seconds, &micros, &path[0]) == 0 || C.GoString(&path[0]) != expectedPath {
		return notaloneProcessIdentity{}, errors.New("source_process_unverified")
	}
	return notaloneProcessIdentity{pid, expectedPath, uint64(seconds), uint64(micros)}, nil
}

// 固定名称定位唯一微信主进程，再核对真实可执行路径；不接受RPC传入PID或路径。
func selectedNotaloneWechatProcess(ctx context.Context) (notaloneProcessIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "/usr/bin/pgrep", "-x", "WeChat").Output()
	fields := strings.Fields(string(output))
	if err != nil || len(fields) != 1 {
		return notaloneProcessIdentity{}, errors.New("source_process_unverified")
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		return notaloneProcessIdentity{}, errors.New("source_process_unverified")
	}
	return readNotaloneProcessIdentity(pid, "/Applications/WeChat.app/Contents/MacOS/WeChat")
}

// 进程启动时刻防止PID复用；内核退出/exec事件在两次核验之间锁存失效。
func (guard *notaloneSourceGuard) WatchProcess(identity notaloneProcessIdentity) error {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if guard.closed || guard.invalid || guard.monitoring {
		return errors.New("source_guard_changed")
	}
	current, err := readNotaloneProcessIdentity(identity.pid, identity.path)
	if err != nil || current != identity {
		return errors.New("source_process_unverified")
	}
	var event syscall.Kevent_t
	syscall.SetKevent(&event, identity.pid, syscall.EVFILT_PROC, syscall.EV_ADD|syscall.EV_CLEAR)
	event.Fflags = syscall.NOTE_EXIT | syscall.NOTE_EXEC
	var events [1]syscall.Kevent_t
	zero := syscall.Timespec{}
	count, watchErr := syscall.Kevent(guard.queue, []syscall.Kevent_t{event}, events[:], &zero)
	current, err = readNotaloneProcessIdentity(identity.pid, identity.path)
	if watchErr != nil || count != 0 || err != nil || current != identity || !guard.checkEvents() {
		guard.invalid = true
		guard.lostOnce.Do(func() { close(guard.lost) })
		return errors.New("source_process_unverified")
	}
	guard.processes = append(guard.processes, identity)
	return nil
}
