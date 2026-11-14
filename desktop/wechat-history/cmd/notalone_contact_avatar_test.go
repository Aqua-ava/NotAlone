package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func avatarMetadataRequest(h *notaloneHistorySession, username string) notaloneHistoryRequest {
	return notaloneHistoryRequest{Operation: "metadata-avatar", Account: h.server.cfg.Wxid, Conversation: username, Consent: "selected-contact-avatar-metadata-v1"}
}

func TestNotAloneAvatarReadsOnlyExactLocalPrivateContact(t *testing.T) {
	h := localAvatarFixture(t)
	writer := accountMetadataWriter(t, h, "contact")
	if err := writer.Exec(`UPDATE contact SET small_head_url='https://example.invalid/NEVER_REQUEST',big_head_url='https://example.invalid/NEVER_REQUEST',description='BODY_SENTINEL' WHERE username='friend-a';`); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a"))
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneContactAvatarMetadata)
	if report.Format != "wechat-contact-avatar-local-v1" || report.Username != "friend-a" || report.Avatar == nil || report.Avatar.MIMEType != "image/png" || report.Avatar.DataBase64 != syntheticAvatarPNG || report.Account.Status != "verified" {
		t.Fatal("本机头像未按精确联系人返回")
	}
	encoded, _ := json.Marshal(report)
	for _, forbidden := range []string{"OTHER_CONTACT", "BODY_SENTINEL", "displayName", "avatarUrl", "NEVER_REQUEST"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("头像响应越过单个联系人的本机位图范围")
		}
	}
}

const syntheticAvatarPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func localAvatarFixture(t *testing.T) *notaloneHistorySession {
	t.Helper()
	h := accountMetadataFixture(t, true)
	notaloneTestDB(t, h.server.cfg.DBRoot, h.server.cfg, "head_image", "head_image.db", `CREATE TABLE head_image(username TEXT PRIMARY KEY,md5 TEXT,image_buffer BLOB,update_time INTEGER);`, strings.Repeat("55", 16))
	data, _ := json.Marshal(h.server.cfg)
	if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), data, 0600); err != nil {
		t.Fatal(err)
	}
	db := accountMetadataWriter(t, h, "head_image")
	image, _ := base64.StdEncoding.DecodeString(syntheticAvatarPNG)
	if err := db.ExecArgs("INSERT INTO head_image(username,image_buffer) VALUES(?,?)", "friend-a", image); err != nil {
		t.Fatal(err)
	}
	if err := db.ExecArgs("INSERT INTO head_image(username,image_buffer) VALUES(?,?)", "friend-b", []byte("OTHER_CONTACT")); err != nil {
		t.Fatal(err)
	}
	return h
}

func TestNotAloneAvatarRejectsUnverifiedOrAmbiguousIdentity(t *testing.T) {
	for _, mutation := range []string{
		`DELETE FROM contact WHERE username='friend-a'`,
		`INSERT INTO contact(username,verify_flag) VALUES('friend-a',0)`,
		`UPDATE contact SET verify_flag=8 WHERE username='friend-a'`,
	} {
		t.Run(mutation, func(t *testing.T) {
			h := accountMetadataFixture(t, true)
			if err := accountMetadataWriter(t, h, "contact").Exec(mutation); err != nil {
				t.Fatal(err)
			}
			if _, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a")); err == nil {
				t.Fatal("无效身份取得头像")
			}
		})
	}
	h := accountMetadataFixture(t, false)
	if _, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a")); err == nil {
		t.Fatal("未经核验的结构取得头像")
	}
}

func TestNotAloneLocalAvatarMissingOrInvalidImageIsNull(t *testing.T) {
	for _, data := range [][]byte{nil, []byte("https://wx.qlogo.cn/NEVER_REQUEST"), []byte("<svg/>"), append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, notaloneAvatarByteLimit)...)} {
		if notaloneLocalAvatar(data) != nil {
			t.Fatal("无效本机头像取得位图回执")
		}
	}
	h := localAvatarFixture(t)
	if err := accountMetadataWriter(t, h, "head_image").Exec("DELETE FROM head_image WHERE username='friend-a'"); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a"))
	if err != nil || value.(notaloneContactAvatarMetadata).Avatar != nil {
		t.Fatal("缺少本机头像应返回null", err)
	}
	missing := accountMetadataFixture(t, true)
	value, err = missing.handle(context.Background(), avatarMetadataRequest(missing, "friend-a"))
	if err != nil || value.(notaloneContactAvatarMetadata).Avatar != nil {
		t.Fatal("没有头像库不得回退网址", err)
	}
}

func TestNotAloneLocalAvatarRejectsUnknownSchemaSymlinkAndCancellation(t *testing.T) {
	h := localAvatarFixture(t)
	if err := accountMetadataWriter(t, h, "head_image").Exec("ALTER TABLE head_image ADD COLUMN unexpected TEXT"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a")); err == nil {
		t.Fatal("未知头像结构被接受")
	}
	linked := localAvatarFixture(t)
	file := filepath.Join(linked.server.cfg.DBRoot, "db_storage/head_image/head_image.db")
	if err := os.Rename(file, file+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(file+".saved", file); err != nil {
		t.Fatal(err)
	}
	if _, err := linked.handle(context.Background(), avatarMetadataRequest(linked, "friend-a")); err == nil {
		t.Fatal("符号链接头像库被接受")
	}
	cancelled := localAvatarFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cancelled.handle(ctx, avatarMetadataRequest(cancelled, "friend-a")); err == nil {
		t.Fatal("取消仍读取头像")
	}
}

func TestNotAloneAvatarRequiresExactConsentAndScope(t *testing.T) {
	h := accountMetadataFixture(t, true)
	for _, mutate := range []func(*notaloneHistoryRequest){
		func(r *notaloneHistoryRequest) { r.Consent = "private-session-list-metadata-v1" },
		func(r *notaloneHistoryRequest) { r.Account = "another-owner" },
		func(r *notaloneHistoryRequest) { r.Conversation = "room@chatroom" },
		func(r *notaloneHistoryRequest) { r.Conversation = "filehelper" },
		func(r *notaloneHistoryRequest) { r.Conversation = "" },
		func(r *notaloneHistoryRequest) { r.DisplayName = "合成目标" },
		func(r *notaloneHistoryRequest) { r.Limit = 2 },
		func(r *notaloneHistoryRequest) { r.Partition = "injected" },
	} {
		r := avatarMetadataRequest(h, "friend-a")
		mutate(&r)
		if _, err := h.handle(context.Background(), r); err == nil {
			t.Fatal("头像读取接受错误许可或身份")
		}
	}
}
