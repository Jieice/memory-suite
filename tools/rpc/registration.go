package rpc

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
)

const (
	TagSessionID      byte = 0x01
	TagChallengeNonce byte = 0x02
	TagNextActionURL  byte = 0x03
)

type RegistrationResponse struct {
	SessionID            string `json:"session_id"`
	ChallengeNonce       []byte `json:"challenge_nonce"`
	ChallengeNonceBase64 string `json:"challenge_nonce_base64"`
	NextActionURL        string `json:"next_action_url"`
}

func DecodeRegistrationResponse(reader io.Reader) (RegistrationResponse, error) {
	if reader == nil {
		return RegistrationResponse{}, ErrNilReader
	}

	var response RegistrationResponse
	parser := NewParser(Options{})
	parser.Register(TagSessionID, func(field Field) error {
		response.SessionID = string(field.Value)
		return nil
	})
	parser.Register(TagChallengeNonce, func(field Field) error {
		response.ChallengeNonce = append(response.ChallengeNonce[:0], field.Value...)
		response.ChallengeNonceBase64 = base64.StdEncoding.EncodeToString(field.Value)
		return nil
	})
	parser.Register(TagNextActionURL, func(field Field) error {
		response.NextActionURL = string(field.Value)
		return nil
	})

	if _, err := parser.Parse(reader); err != nil {
		return RegistrationResponse{}, err
	}

	if response.SessionID == "" {
		return RegistrationResponse{}, fmt.Errorf("registration TLV missing tag 0x%02x session_id", TagSessionID)
	}
	if len(response.ChallengeNonce) == 0 {
		return RegistrationResponse{}, fmt.Errorf("registration TLV missing tag 0x%02x challenge_nonce", TagChallengeNonce)
	}
	if response.NextActionURL == "" {
		return RegistrationResponse{}, fmt.Errorf("registration TLV missing tag 0x%02x next_action_url", TagNextActionURL)
	}

	return response, nil
}

func EncodeRegistrationResponse(response RegistrationResponse) []byte {
	var output bytes.Buffer
	writeField(&output, TagSessionID, []byte(response.SessionID))
	writeField(&output, TagChallengeNonce, response.ChallengeNonce)
	writeField(&output, TagNextActionURL, []byte(response.NextActionURL))
	return output.Bytes()
}

func writeField(output *bytes.Buffer, tag byte, value []byte) {
	output.WriteByte(tag)
	output.WriteByte(byte(len(value)))
	output.WriteByte(byte(len(value) >> 8))
	output.Write(value)
}
