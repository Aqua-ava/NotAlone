package main

import (
	"bytes"
	"errors"
	"unicode/utf8"

	"github.com/klauspost/compress/zstd"
)

const notaloneTextByteLimit = 65536

var (
	errNotaloneTextUnknown = errors.New("history_text_unknown")
	errNotaloneTextInvalid = errors.New("history_text_invalid")
)

// 仅处理已确定为文字的行；未知输入不补为空文，解码失败不回传原始内容。
func decodeNotaloneText(value any) (*string, error) {
	var input []byte
	switch raw := value.(type) {
	case string:
		if len(raw) > notaloneTextByteLimit {
			return nil, errNotaloneTextInvalid
		}
		input = []byte(raw)
	case []byte:
		if raw == nil {
			return nil, errNotaloneTextUnknown
		}
		if len(raw) > notaloneTextByteLimit {
			return nil, errNotaloneTextInvalid
		}
		input = raw
	default:
		return nil, errNotaloneTextUnknown
	}
	if bytes.HasPrefix(input, []byte{0x28, 0xb5, 0x2f, 0xfd}) {
		decoder, err := zstd.NewReader(nil,
			zstd.WithDecoderConcurrency(1),
			zstd.WithDecoderMaxMemory(8<<20),
			zstd.WithDecoderMaxWindow(8<<20),
			zstd.WithDecodeAllCapLimit(true),
		)
		if err != nil {
			return nil, errNotaloneTextInvalid
		}
		defer decoder.Close()
		input, err = decoder.DecodeAll(input, make([]byte, 0, notaloneTextByteLimit))
		if err != nil {
			return nil, errNotaloneTextInvalid
		}
	}
	if len(input) > notaloneTextByteLimit || !utf8.Valid(input) {
		return nil, errNotaloneTextInvalid
	}
	text := string(input)
	return &text, nil
}
