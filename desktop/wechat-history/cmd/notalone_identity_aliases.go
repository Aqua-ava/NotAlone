//go:build darwin

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"unicode/utf8"

	"github.com/r266-tech/wx-cli/v2/internal/config"
)

// 仅在命令开始、任何来源守卫创建前装配；运行期间不改变。
var notaloneSourceIdentityAliases map[string]string

func notaloneAliasedFingerprint(canonical string, aliases map[string]string) string {
	if legacy, ok := aliases[canonical]; ok {
		return legacy
	}
	return canonical
}

func notaloneUniqueJSON(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); ok {
		seen := map[string]bool{}
		for decoder.More() {
			if delimiter == '{' {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return notaloneFailure("history_source_unverified")
				}
				seen[name] = true
			}
			if err := notaloneUniqueJSON(decoder); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
	}
	return err
}

// 固定旁侧文件只保存经本机核验的实例别名；不接受 RPC 路径、设备号或来源扫描。
func loadNotaloneIdentityAliases(path, account, artifact string, sourceRoot ...string) (map[string]string, error) {
	fail := func() (map[string]string, error) { return nil, notaloneFailure("history_source_unverified") }
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fail()
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm() != 0600 || before.Size() > 65536 {
		return fail()
	}
	stat, ok := before.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return fail()
	}
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 || !utf8.Valid(data) {
		return fail()
	}
	after, err := file.Stat()
	if err != nil || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || int64(len(data)) != after.Size() {
		return fail()
	}
	unique := json.NewDecoder(bytes.NewReader(data))
	if notaloneUniqueJSON(unique) != nil {
		return fail()
	}
	if _, err := unique.Token(); err != io.EOF {
		return fail()
	}
	var record struct {
		Format     string            `json:"format"`
		AccountKey string            `json:"accountKey"`
		Artifact   string            `json:"artifactSha256"`
		RootScope  string            `json:"rootScope"`
		Aliases    map[string]string `json:"aliases"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&record) != nil {
		return fail()
	}
	if record.Format != "notalone-source-identity-aliases-v1" || record.AccountKey != account || record.Artifact != artifact || len(record.Aliases) == 0 || len(record.Aliases) > 128 {
		return fail()
	}
	if len(sourceRoot) > 0 && record.RootScope != notaloneHash(account, filepath.Clean(sourceRoot[0])) {
		return fail()
	}
	hash := regexp.MustCompile(`^[a-f0-9]{64}$`)
	used := map[string]bool{}
	for canonical, legacy := range record.Aliases {
		if !hash.MatchString(canonical) || !hash.MatchString(legacy) || canonical == legacy || used[legacy] {
			return fail()
		}
		if _, overlap := record.Aliases[legacy]; overlap {
			return fail()
		}
		used[legacy] = true
	}
	return record.Aliases, nil
}

func loadDefaultNotaloneIdentityAliases() (map[string]string, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(filepath.Dir(filepath.Dir(executable)), "source-identity-aliases.json")
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	artifact, err := notaloneFileHash(executable)
	if err != nil {
		return nil, err
	}
	return loadNotaloneIdentityAliases(path, cfg.Wxid, artifact, cfg.DBRoot)
}
