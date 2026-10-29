//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestNotaloneGuardRejectsNamespaceChanges(t *testing.T) {
	for _, change := range []string{"replace", "replace_and_restore", "add", "add_and_remove", "remove", "directory_replace", "directory_replace_and_restore"} {
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
			case "add", "add_and_remove":
				added := filepath.Join(directory, "message_1.db")
				must(os.WriteFile(added, nil, 0600))
				if change == "add_and_remove" {
					must(os.Remove(added))
				}
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
