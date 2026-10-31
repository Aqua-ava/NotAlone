//go:build darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNotaloneIdentityAliasesRequireExactAccountAndArtifact(t *testing.T) {
	canonical, legacy, artifact := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	path := filepath.Join(t.TempDir(), "aliases.json")
	record := map[string]any{"format": "notalone-source-identity-aliases-v1", "accountKey": "synthetic-owner", "artifactSha256": artifact, "rootScope": notaloneHash("synthetic-owner", "/synthetic/root"), "aliases": map[string]string{canonical: legacy}}
	write := func() {
		bytes, _ := json.Marshal(record)
		if err := os.WriteFile(path, bytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact, "/synthetic/root"); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact, "/other/root"); err == nil {
		t.Fatal("其他来源目录复用了别名")
	}
	if err := os.WriteFile(path, []byte(`{"format":"notalone-source-identity-aliases-v1","format":"notalone-source-identity-aliases-v1"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err == nil {
		t.Fatal("重复JSON字段未拒绝")
	}
	write()
	aliases, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact)
	if err != nil || notaloneAliasedFingerprint(canonical, aliases) != legacy || notaloneAliasedFingerprint(artifact, aliases) != artifact {
		t.Fatalf("精确旧身份别名未保留或未知实例被改写: %v", err)
	}
	if _, err := loadNotaloneIdentityAliases(path, "other-owner", artifact); err == nil {
		t.Fatal("其他账号复用了来源别名")
	}
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", canonical); err == nil {
		t.Fatal("其他制品复用了来源别名")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err == nil {
		t.Fatal("可公开读取的别名文件未拒绝")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := loadNotaloneIdentityAliases(link, "synthetic-owner", artifact); err == nil {
		t.Fatal("符号链接别名文件未拒绝")
	}
	record["aliases"] = map[string]string{canonical: legacy, artifact: legacy}
	write()
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err == nil {
		t.Fatal("多对一实例别名未拒绝")
	}
	record["aliases"] = map[string]string{canonical: legacy, legacy: artifact}
	write()
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err == nil {
		t.Fatal("可重叠的实例别名未拒绝")
	}
	large := make(map[string]string, notaloneIdentityAliasesLimit)
	for index := 1; index <= notaloneIdentityAliasesLimit; index++ {
		large[fmt.Sprintf("%064x", index)] = fmt.Sprintf("%064x", index+notaloneIdentityAliasesLimit*2)
	}
	record["aliases"] = large
	write()
	info, err := os.Stat(path)
	if err != nil || info.Size() > notaloneIdentityAliasesByteLimit {
		t.Fatalf("合成大映射fixture超过既定1MiB上限：%v", err)
	}
	if aliases, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err != nil || len(aliases) != notaloneIdentityAliasesLimit {
		t.Fatalf("4096条opaque映射必须可加载：count=%d err=%v", len(aliases), err)
	}
	record["padding"] = strings.Repeat("x", notaloneIdentityAliasesByteLimit)
	write()
	if _, err := loadNotaloneIdentityAliases(path, "synthetic-owner", artifact); err == nil {
		t.Fatal("超过1MiB的别名清单未拒绝")
	}
}

func TestNotaloneGuardAppliesVerifiedIdentityAliases(t *testing.T) {
	directory, file := notaloneGuardFixture(t)
	canonical, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	whole := canonical.Fingerprint()
	partition, err := canonical.FileFingerprint(file)
	_ = canonical.Close()
	if err != nil {
		t.Fatal(err)
	}
	previous := notaloneSourceIdentityAliases
	notaloneSourceIdentityAliases = map[string]string{whole: strings.Repeat("d", 64), partition: strings.Repeat("e", 64)}
	defer func() { notaloneSourceIdentityAliases = previous }()
	guard, err := newNotaloneSourceGuard(directory, []string{file})
	if err != nil {
		t.Fatal(err)
	}
	defer guard.Close()
	if guard.Fingerprint() != strings.Repeat("d", 64) {
		t.Fatal("账号复合实例未承接已核验的旧标识")
	}
	actual, err := guard.FileFingerprint(file)
	if err != nil || actual != strings.Repeat("e", 64) {
		t.Fatalf("分片实例未承接已核验的旧标识: %v", err)
	}
	if err := guard.Check(); err != nil {
		t.Fatal(err)
	}
}
