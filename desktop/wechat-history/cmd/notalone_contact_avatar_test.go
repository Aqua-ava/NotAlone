package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func avatarMetadataRequest(h *notaloneHistorySession, username string) notaloneHistoryRequest {
	return notaloneHistoryRequest{Operation: "metadata-avatar", Account: h.server.cfg.Wxid, Conversation: username, Consent: "selected-contact-avatar-metadata-v1"}
}

func TestNotAloneAvatarReadsOnlyExactPrivateContact(t *testing.T) {
	h := accountMetadataFixture(t, true)
	writer := accountMetadataWriter(t, h, "contact")
	if err := writer.Exec(`UPDATE contact SET small_head_url='https://wx.qlogo.cn/mmhead/synthetic-small/132',big_head_url='https://wx.qlogo.cn/mmhead/synthetic-big/0',description='BODY_SENTINEL' WHERE username='friend-a'; UPDATE contact SET small_head_url='https://wx.qlogo.cn/mmhead/OTHER_CONTACT/132' WHERE username='friend-b';`); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a"))
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneContactAvatarMetadata)
	if report.Username != "friend-a" || report.AvatarURL == nil || *report.AvatarURL != "https://wx.qlogo.cn/mmhead/synthetic-small/132" || report.Account.Status != "verified" {
		t.Fatal(report)
	}
	encoded, _ := json.Marshal(report)
	for _, forbidden := range []string{"OTHER_CONTACT", "BODY_SENTINEL", "displayName", "big_head_url"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("头像响应越过单个联系人的最小展示范围")
		}
	}
	if err := writer.Exec(`UPDATE contact SET small_head_url='',big_head_url='https://thirdwx.qlogo.cn/mmopen/synthetic/0' WHERE username='friend-a'`); err != nil {
		t.Fatal(err)
	}
	value, err = h.handle(context.Background(), avatarMetadataRequest(h, "friend-a"))
	if err != nil || value.(notaloneContactAvatarMetadata).AvatarURL == nil || *value.(notaloneContactAvatarMetadata).AvatarURL != "https://thirdwx.qlogo.cn/mmopen/synthetic/0" {
		t.Fatal("未使用合法大头像兜底", err)
	}
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

func TestNotAloneAvatarMissingOrUnsafeURLIsNull(t *testing.T) {
	for _, raw := range []string{"", "http://example.invalid/x", "https://wx.qlogo.cn.evil.invalid/x", "https://example.invalid/x", "https://user@wx.qlogo.cn/x", "https://wx.qlogo.cn:444/x", "file:///private/avatar", "https://wx.qlogo.cn/x#fragment", "https://wx.qlogo.cn", "https://wx.qlogo.cn\\evil.invalid/x", "https://wx.qlogo.cn/ a"} {
		if notaloneAvatarURL(raw) != nil {
			t.Fatalf("接收了不安全头像地址 %q", raw)
		}
	}
	for _, host := range []string{"wx.qlogo.cn", "thirdwx.qlogo.cn"} {
		secure := notaloneAvatarURL("http://" + host + "/mmhead/synthetic/132")
		if secure == nil || *secure != "https://"+host+"/mmhead/synthetic/132" {
			t.Fatal("固定头像CDN旧地址没有升级为HTTPS")
		}
	}
	h := accountMetadataFixture(t, true)
	value, err := h.handle(context.Background(), avatarMetadataRequest(h, "friend-a"))
	if err != nil || value.(notaloneContactAvatarMetadata).AvatarURL != nil {
		t.Fatal("缺少头像应返回null", err)
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
