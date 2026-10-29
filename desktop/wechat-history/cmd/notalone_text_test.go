package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func TestDecodeNotaloneTextPlainUTF8(t *testing.T) {
	for _, input := range []any{"合成中文与 emoji：你好🙂", []byte("合成中文与 emoji：你好🙂"), "", []byte{}} {
		decoded, err := decodeNotaloneText(input)
		if err != nil || decoded == nil {
			t.Fatalf("合法UTF-8文字应成功：%v", err)
		}
		want := "合成中文与 emoji：你好🙂"
		if len(inputBytes(input)) == 0 {
			want = ""
		}
		if *decoded != want {
			t.Fatal("解码文字不一致")
		}
	}
}

func TestDecodeNotaloneTextPlainBoundary(t *testing.T) {
	want := strings.Repeat("甲", 21845) + "a"
	decoded, err := decodeNotaloneText(want)
	if err != nil || decoded == nil || *decoded != want {
		t.Fatal("65536字节UTF-8文字应完整保留")
	}
	for _, input := range []any{want + "b", []byte(want + "b")} {
		assertNotaloneTextError(t, input, "history_text_invalid")
	}
}

func TestDecodeNotaloneTextUnknownAndInvalidUTF8(t *testing.T) {
	for _, input := range []any{nil, []byte(nil), 42, true} {
		assertNotaloneTextError(t, input, "history_text_unknown")
	}
	for _, input := range []any{[]byte{0xff, 0xfe}, string([]byte{0xff}), []byte{0xe4, 0xb8}} {
		assertNotaloneTextError(t, input, "history_text_invalid")
	}
}

func TestDecodeNotaloneTextAfterBoundedRead(t *testing.T) {
	library := os.Getenv("NOTALONE_TEST_WCDB")
	if library == "" {
		t.Skip("未指定隔离测试使用的 WCDB 制品")
	}
	if err := wcdb.BootstrapBounded(library); err != nil {
		t.Fatal(err)
	}
	db, err := wcdb.OpenPlain(filepath.Join(t.TempDir(), "synthetic.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, input := range [][]byte{
		[]byte("a\x00b"),
		{'a', 0, 0xff},
		compressedNotaloneText(t, []byte("合成压缩文字\x00尾部")),
	} {
		rows, err := db.QueryBounded(context.Background(), 1, "SELECT CAST(? AS TEXT) AS content", input)
		if err != nil || len(rows) != 1 {
			t.Fatalf("合成TEXT读取失败：%v", err)
		}
		decoded, err := decodeNotaloneText(rows[0]["content"])
		if bytes.Equal(input, []byte{'a', 0, 0xff}) {
			if decoded != nil || err == nil || err.Error() != "history_text_invalid" {
				t.Fatal("NUL后损坏UTF-8必须隔离且不返回前缀正文")
			}
			continue
		}
		want := "a\x00b"
		if bytes.HasPrefix(input, []byte{0x28, 0xb5, 0x2f, 0xfd}) {
			want = "合成压缩文字\x00尾部"
		}
		if err != nil || decoded == nil || *decoded != want {
			t.Fatalf("TEXT完整字节未到达解码器：%v", err)
		}
	}
}

func TestDecodeNotaloneTextZstdUTF8AndBoundary(t *testing.T) {
	for _, want := range []string{"合成压缩中文：你好🙂", strings.Repeat("甲", 21845) + "a", ""} {
		compressed := compressedNotaloneText(t, []byte(want))
		for _, input := range []any{compressed, string(compressed)} {
			decoded, err := decodeNotaloneText(input)
			if err != nil || decoded == nil || *decoded != want {
				t.Fatalf("合法有界Zstd应完整解压：%v", err)
			}
		}
	}
}

func TestDecodeNotaloneTextZstdRejectsDamageBombAndInvalidUTF8(t *testing.T) {
	valid := compressedNotaloneText(t, []byte("合成文字"))
	corrupt := append([]byte(nil), valid...)
	corrupt[len(corrupt)-1] ^= 0xff
	for _, input := range [][]byte{
		{0x28, 0xb5, 0x2f, 0xfd},
		valid[:len(valid)-1],
		corrupt,
		compressedNotaloneText(t, bytes.Repeat([]byte("x"), 65537)),
		compressedNotaloneText(t, bytes.Repeat([]byte("x"), 16<<20)),
		compressedNotaloneText(t, []byte{0xff, 0xfe}),
		append([]byte{0x28, 0xb5, 0x2f, 0xfd}, make([]byte, 65533)...),
	} {
		assertNotaloneTextError(t, input, "history_text_invalid")
	}
}

func TestDecodeNotaloneTextZstdConcatenatedLimit(t *testing.T) {
	one := compressedNotaloneText(t, bytes.Repeat([]byte("x"), 32768))
	decoded, err := decodeNotaloneText(append(append([]byte(nil), one...), one...))
	if err != nil || decoded == nil || len(*decoded) != 65536 {
		t.Fatal("拼接帧总输出65536字节应成功")
	}
	over := append(append(append([]byte(nil), one...), one...), compressedNotaloneText(t, []byte("y"))...)
	assertNotaloneTextError(t, over, "history_text_invalid")
}

func TestDecodeNotaloneTextZstdInputBoundary(t *testing.T) {
	for _, size := range []int{65536, 131072} {
		encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithEncoderPadding(size))
		if err != nil {
			t.Fatal(err)
		}
		input := encoder.EncodeAll([]byte("合成有界文字"), nil)
		encoder.Close()
		if len(input) != size {
			t.Fatal("合成压缩输入未覆盖指定边界")
		}
		if size > 65536 {
			assertNotaloneTextError(t, input, "history_text_invalid")
			continue
		}
		decoded, err := decodeNotaloneText(input)
		if err != nil || decoded == nil || *decoded != "合成有界文字" {
			t.Fatal("65536字节合法压缩输入应成功")
		}
	}
}

func TestDecodeNotaloneTextZstdWindowLimit(t *testing.T) {
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1), zstd.WithWindowSize(16<<20), zstd.WithSingleSegment(false))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	input := encoder.EncodeAll([]byte("合成大窗口文字"), nil)
	if input[4]&(1<<5) != 0 {
		t.Fatal("窗口边界夹具不能使用single-segment")
	}
	// 锁定库decodeheader.go按10+(descriptor>>3)解析窗口；合成16MiB窗口。
	input[5] = (24 - 10) << 3
	decoder, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	defer decoder.Close()
	plain, err := decoder.DecodeAll(input, nil)
	if err != nil || string(plain) != "合成大窗口文字" {
		t.Fatal("大窗口夹具本身必须是合法Zstd")
	}
	assertNotaloneTextError(t, input, "history_text_invalid")
}

func compressedNotaloneText(t *testing.T, input []byte) []byte {
	t.Helper()
	encoder, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	return encoder.EncodeAll(input, nil)
}

func assertNotaloneTextError(t *testing.T, input any, code string) {
	t.Helper()
	decoded, err := decodeNotaloneText(input)
	if decoded != nil || err == nil || err.Error() != code {
		t.Fatalf("失败必须不返回正文，且只返回固定错误码%s", code)
	}
}

func inputBytes(input any) []byte {
	switch value := input.(type) {
	case string:
		return []byte(value)
	case []byte:
		return value
	default:
		return nil
	}
}
