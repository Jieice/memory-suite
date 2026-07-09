package rpc

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"testing"
)

func TestParseTLVFields(t *testing.T) {
	input := bytes.NewReader([]byte{
		0x01, 0x03, 0x00, 'f', 'o', 'o',
		0x02, 0x02, 0x00, 'b', 'a',
		0x01, 0x03, 0x00, 'r', 'b', 'z',
	})

	got, err := Parse(input)
	if err != nil {
		t.Fatalf("parse TLV: %v", err)
	}

	want := map[byte][]byte{
		0x01: []byte("foorbz"),
		0x02: []byte("ba"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed fields = %#v, want %#v", got, want)
	}
}

func TestRegisteredHandler(t *testing.T) {
	var seen []Field
	parser := NewParser(Options{})
	parser.Register(0x10, func(field Field) error {
		seen = append(seen, field)
		return nil
	})

	input := bytes.NewReader([]byte{
		0x10, 0x03, 0x00, 'o', 'n', 'e',
		0x20, 0x03, 0x00, 't', 'w', 'o',
		0x10, 0x05, 0x00, 't', 'h', 'r', 'e', 'e',
	})

	fields, err := parser.Parse(input)
	if err != nil {
		t.Fatalf("parse TLV: %v", err)
	}

	if string(fields[0x10]) != "onethree" {
		t.Fatalf("tag 0x10 output = %q, want onethree", fields[0x10])
	}
	if len(seen) != 2 {
		t.Fatalf("handler call count = %d, want 2", len(seen))
	}
	if seen[0].Tag != 0x10 || seen[0].Length != 3 || string(seen[0].Value) != "one" {
		t.Fatalf("first handler field = %#v", seen[0])
	}
	if seen[1].Tag != 0x10 || seen[1].Length != 5 || string(seen[1].Value) != "three" {
		t.Fatalf("second handler field = %#v", seen[1])
	}
}

func TestHandlerErrorStopsParse(t *testing.T) {
	handlerErr := errors.New("handler failed")
	parser := NewParser(Options{
		Handlers: map[byte]Handler{
			0x01: func(Field) error {
				return handlerErr
			},
		},
	})

	_, err := parser.Parse(bytes.NewReader([]byte{0x01, 0x01, 0x00, 'x'}))
	if !errors.Is(err, handlerErr) {
		t.Fatalf("error = %v, want handler error", err)
	}
}

func TestUnexpectedEOFInHeader(t *testing.T) {
	_, err := Parse(bytes.NewReader([]byte{0x01, 0x02}))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("error = %v, want io.ErrUnexpectedEOF", err)
	}
}

func TestUnexpectedEOFInValue(t *testing.T) {
	_, err := Parse(bytes.NewReader([]byte{0x01, 0x03, 0x00, 'x'}))
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("error = %v, want io.ErrUnexpectedEOF", err)
	}
}

func TestLengthLimit(t *testing.T) {
	parser := NewParser(Options{MaxLength: 2})
	_, err := parser.Parse(bytes.NewReader([]byte{0x01, 0x03, 0x00, 'a', 'b', 'c'}))
	if !errors.Is(err, ErrLengthExceeded) {
		t.Fatalf("error = %v, want ErrLengthExceeded", err)
	}
}

func TestZeroLengthValue(t *testing.T) {
	fields, err := Parse(bytes.NewReader([]byte{0x01, 0x00, 0x00}))
	if err != nil {
		t.Fatalf("parse zero-length value: %v", err)
	}

	value, ok := fields[0x01]
	if !ok {
		t.Fatal("missing tag 0x01")
	}
	if len(value) != 0 {
		t.Fatalf("zero-length value len = %d, want 0", len(value))
	}
}

func TestDecodeRegistrationResponse(t *testing.T) {
	encoded := EncodeRegistrationResponse(RegistrationResponse{
		SessionID:      "session-123",
		ChallengeNonce: []byte{0xde, 0xad, 0xbe, 0xef},
		NextActionURL:  "https://example.test/challenge",
	})

	decoded, err := DecodeRegistrationResponse(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("decode registration response: %v", err)
	}
	if decoded.SessionID != "session-123" {
		t.Fatalf("session id = %q, want session-123", decoded.SessionID)
	}
	if !bytes.Equal(decoded.ChallengeNonce, []byte{0xde, 0xad, 0xbe, 0xef}) {
		t.Fatalf("challenge nonce = %x", decoded.ChallengeNonce)
	}
	if decoded.ChallengeNonceBase64 != "3q2+7w==" {
		t.Fatalf("challenge nonce b64 = %q", decoded.ChallengeNonceBase64)
	}
	if decoded.NextActionURL != "https://example.test/challenge" {
		t.Fatalf("next action url = %q", decoded.NextActionURL)
	}
}
