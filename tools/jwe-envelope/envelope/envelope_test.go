package envelope

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestSealPayloadRoundTrip(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	jwkJSON, err := publicJWKJSON(&privateKey.PublicKey, "test-key-1")
	if err != nil {
		t.Fatalf("marshal JWK: %v", err)
	}

	payload := NewPayload(
		"internal-security-test",
		"auth-protocol-validator",
		"nonce-123",
		"sha256:4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c8f7cf4fc5ce4a",
		time.Unix(1783300000, 0),
	)

	envelope, err := SealPayload(jwkJSON, payload, SealOptions{})
	if err != nil {
		t.Fatalf("seal payload: %v", err)
	}

	openedPayload, err := OpenPayload(privateKey, envelope)
	if err != nil {
		t.Fatalf("open payload: %v", err)
	}
	if openedPayload != payload {
		t.Fatalf("opened payload mismatch:\n got: %#v\nwant: %#v", openedPayload, payload)
	}

	plaintext := openEnvelopeForTest(t, privateKey, envelope)

	var got Payload
	if err := json.Unmarshal(plaintext, &got); err != nil {
		t.Fatalf("unmarshal plaintext: %v", err)
	}
	if got != payload {
		t.Fatalf("payload mismatch:\n got: %#v\nwant: %#v", got, payload)
	}

	headerJSON, err := base64URL.DecodeString(envelope.Protected)
	if err != nil {
		t.Fatalf("decode protected header: %v", err)
	}

	var header ProtectedHeader
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		t.Fatalf("unmarshal protected header: %v", err)
	}
	if header.Algorithm != AlgorithmRSAOAEP256 {
		t.Fatalf("unexpected alg: %s", header.Algorithm)
	}
	if header.Encryption != EncryptionA256GCM {
		t.Fatalf("unexpected enc: %s", header.Encryption)
	}
	if header.KeyID != "test-key-1" {
		t.Fatalf("unexpected kid: %s", header.KeyID)
	}
}

func TestSealPayloadRejectsMissingClaims(t *testing.T) {
	_, err := SealPayload([]byte(`{"kty":"RSA","n":"abc","e":"AQAB"}`), Payload{}, SealOptions{})
	if err == nil {
		t.Fatal("expected missing payload claims to fail")
	}
}

func TestSealJSONRejectsNonRSAJWK(t *testing.T) {
	_, err := SealJSON([]byte(`{"kty":"EC","n":"abc","e":"AQAB"}`), []byte(`{}`), SealOptions{})
	if err == nil {
		t.Fatal("expected non-RSA JWK to fail")
	}
}

func publicJWKJSON(publicKey *rsa.PublicKey, keyID string) ([]byte, error) {
	exponent := bigEndianBytes(publicKey.E)
	jwk := PublicJWK{
		KeyType: "RSA",
		KeyID:   keyID,
		Use:     "enc",
		Alg:     AlgorithmRSAOAEP256,
		N:       base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		E:       base64.RawURLEncoding.EncodeToString(exponent),
	}

	return json.Marshal(jwk)
}

func openEnvelopeForTest(t *testing.T, privateKey *rsa.PrivateKey, envelope Envelope) []byte {
	t.Helper()

	encryptedKey, err := base64URL.DecodeString(envelope.EncryptedKey)
	if err != nil {
		t.Fatalf("decode encrypted key: %v", err)
	}
	contentEncryptionKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, privateKey, encryptedKey, nil)
	if err != nil {
		t.Fatalf("decrypt content encryption key: %v", err)
	}

	iv, err := base64URL.DecodeString(envelope.IV)
	if err != nil {
		t.Fatalf("decode iv: %v", err)
	}
	ciphertext, err := base64URL.DecodeString(envelope.Ciphertext)
	if err != nil {
		t.Fatalf("decode ciphertext: %v", err)
	}
	tag, err := base64URL.DecodeString(envelope.Tag)
	if err != nil {
		t.Fatalf("decode tag: %v", err)
	}

	block, err := aes.NewCipher(contentEncryptionKey)
	if err != nil {
		t.Fatalf("create AES cipher: %v", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("create AES-GCM cipher: %v", err)
	}

	sealed := append(ciphertext, tag...)
	plaintext, err := aead.Open(nil, iv, sealed, []byte(envelope.Protected))
	if err != nil {
		t.Fatalf("open AES-GCM payload: %v", err)
	}

	return plaintext
}

func bigEndianBytes(value int) []byte {
	if value == 0 {
		return []byte{0}
	}

	var bytes []byte
	for value > 0 {
		bytes = append([]byte{byte(value)}, bytes...)
		value >>= 8
	}

	return bytes
}
