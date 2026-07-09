package envelope

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"time"
)

const (
	AlgorithmRSAOAEP256 = "RSA-OAEP-256"
	EncryptionA256GCM   = "A256GCM"
	jweType             = "JWE"
	contentTypeJSON     = "application/json"

	aes256KeySize = 32
	gcmNonceSize  = 12
	gcmTagSize    = 16
)

var base64URL = base64.RawURLEncoding

type Payload struct {
	Timestamp             int64  `json:"timestamp"`
	Issuer                string `json:"issuer"`
	Audience              string `json:"audience"`
	Nonce                 string `json:"nonce"`
	ClientFingerprintHash string `json:"client_fingerprint_hash"`
}

type PublicJWK struct {
	KeyType string `json:"kty"`
	KeyID   string `json:"kid,omitempty"`
	Use     string `json:"use,omitempty"`
	Alg     string `json:"alg,omitempty"`
	N       string `json:"n"`
	E       string `json:"e"`
}

type Envelope struct {
	Protected    string `json:"protected"`
	EncryptedKey string `json:"encrypted_key"`
	IV           string `json:"iv"`
	Ciphertext   string `json:"ciphertext"`
	Tag          string `json:"tag"`
}

type ProtectedHeader struct {
	Algorithm   string `json:"alg"`
	Encryption  string `json:"enc"`
	KeyID       string `json:"kid,omitempty"`
	Type        string `json:"typ,omitempty"`
	ContentType string `json:"cty,omitempty"`
}

type SealOptions struct {
	Random io.Reader
}

func NewPayload(issuer, audience, nonce, fingerprintHash string, now time.Time) Payload {
	return Payload{
		Timestamp:             now.Unix(),
		Issuer:                issuer,
		Audience:              audience,
		Nonce:                 nonce,
		ClientFingerprintHash: fingerprintHash,
	}
}

func SealPayload(publicJWKJSON []byte, payload Payload, options SealOptions) (Envelope, error) {
	if err := validatePayload(payload); err != nil {
		return Envelope{}, err
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, fmt.Errorf("marshal payload: %w", err)
	}

	return SealJSON(publicJWKJSON, plaintext, options)
}

func SealJSON(publicJWKJSON []byte, plaintext []byte, options SealOptions) (Envelope, error) {
	publicKey, keyID, err := parseRSAPublicJWK(publicJWKJSON)
	if err != nil {
		return Envelope{}, err
	}
	if len(plaintext) == 0 {
		return Envelope{}, errors.New("plaintext is required")
	}

	random := options.Random
	if random == nil {
		random = rand.Reader
	}

	protected, err := encodeProtectedHeader(keyID)
	if err != nil {
		return Envelope{}, err
	}

	contentEncryptionKey := make([]byte, aes256KeySize)
	if _, err := io.ReadFull(random, contentEncryptionKey); err != nil {
		return Envelope{}, fmt.Errorf("generate content encryption key: %w", err)
	}

	encryptedKey, err := rsa.EncryptOAEP(sha256.New(), random, publicKey, contentEncryptionKey, nil)
	if err != nil {
		return Envelope{}, fmt.Errorf("encrypt content encryption key: %w", err)
	}

	iv := make([]byte, gcmNonceSize)
	if _, err := io.ReadFull(random, iv); err != nil {
		return Envelope{}, fmt.Errorf("generate iv: %w", err)
	}

	block, err := aes.NewCipher(contentEncryptionKey)
	if err != nil {
		return Envelope{}, fmt.Errorf("create AES cipher: %w", err)
	}

	aead, err := cipher.NewGCM(block)
	if err != nil {
		return Envelope{}, fmt.Errorf("create AES-GCM cipher: %w", err)
	}

	sealed := aead.Seal(nil, iv, plaintext, []byte(protected))
	ciphertext := sealed[:len(sealed)-gcmTagSize]
	tag := sealed[len(sealed)-gcmTagSize:]

	return Envelope{
		Protected:    protected,
		EncryptedKey: base64URL.EncodeToString(encryptedKey),
		IV:           base64URL.EncodeToString(iv),
		Ciphertext:   base64URL.EncodeToString(ciphertext),
		Tag:          base64URL.EncodeToString(tag),
	}, nil
}

func OpenPayload(privateKey *rsa.PrivateKey, envelope Envelope) (Payload, error) {
	plaintext, err := OpenJSON(privateKey, envelope)
	if err != nil {
		return Payload{}, err
	}

	var payload Payload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return Payload{}, fmt.Errorf("unmarshal payload: %w", err)
	}
	if err := validatePayload(payload); err != nil {
		return Payload{}, err
	}

	return payload, nil
}

func OpenJSON(privateKey *rsa.PrivateKey, envelope Envelope) ([]byte, error) {
	if privateKey == nil {
		return nil, errors.New("private key is required")
	}

	encryptedKey, err := base64URL.DecodeString(envelope.EncryptedKey)
	if err != nil {
		return nil, fmt.Errorf("decode encrypted key: %w", err)
	}
	contentEncryptionKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, privateKey, encryptedKey, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt content encryption key: %w", err)
	}

	iv, err := base64URL.DecodeString(envelope.IV)
	if err != nil {
		return nil, fmt.Errorf("decode iv: %w", err)
	}
	ciphertext, err := base64URL.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}
	tag, err := base64URL.DecodeString(envelope.Tag)
	if err != nil {
		return nil, fmt.Errorf("decode tag: %w", err)
	}

	block, err := aes.NewCipher(contentEncryptionKey)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create AES-GCM cipher: %w", err)
	}

	sealed := append(append([]byte(nil), ciphertext...), tag...)
	plaintext, err := aead.Open(nil, iv, sealed, []byte(envelope.Protected))
	if err != nil {
		return nil, fmt.Errorf("open AES-GCM payload: %w", err)
	}

	return plaintext, nil
}

func parseRSAPublicJWK(publicJWKJSON []byte) (*rsa.PublicKey, string, error) {
	var jwk PublicJWK
	if err := json.Unmarshal(publicJWKJSON, &jwk); err != nil {
		return nil, "", fmt.Errorf("parse public JWK: %w", err)
	}
	if jwk.KeyType != "RSA" {
		return nil, "", fmt.Errorf("unsupported JWK kty %q", jwk.KeyType)
	}
	if jwk.N == "" {
		return nil, "", errors.New("JWK n is required")
	}
	if jwk.E == "" {
		return nil, "", errors.New("JWK e is required")
	}

	modulusBytes, err := base64URL.DecodeString(jwk.N)
	if err != nil {
		return nil, "", fmt.Errorf("decode JWK n: %w", err)
	}
	exponentBytes, err := base64URL.DecodeString(jwk.E)
	if err != nil {
		return nil, "", fmt.Errorf("decode JWK e: %w", err)
	}

	modulus := new(big.Int).SetBytes(modulusBytes)
	if modulus.Sign() <= 0 {
		return nil, "", errors.New("JWK n must be a positive integer")
	}

	exponent := new(big.Int).SetBytes(exponentBytes)
	if !exponent.IsInt64() {
		return nil, "", errors.New("JWK e is too large")
	}

	exponentInt := int(exponent.Int64())
	if exponentInt < 3 {
		return nil, "", errors.New("JWK e must be >= 3")
	}

	return &rsa.PublicKey{N: modulus, E: exponentInt}, jwk.KeyID, nil
}

func encodeProtectedHeader(keyID string) (string, error) {
	header := ProtectedHeader{
		Algorithm:   AlgorithmRSAOAEP256,
		Encryption:  EncryptionA256GCM,
		KeyID:       keyID,
		Type:        jweType,
		ContentType: contentTypeJSON,
	}

	headerJSON, err := json.Marshal(header)
	if err != nil {
		return "", fmt.Errorf("marshal protected header: %w", err)
	}

	return base64URL.EncodeToString(headerJSON), nil
}

func validatePayload(payload Payload) error {
	if payload.Timestamp <= 0 {
		return errors.New("payload timestamp is required")
	}
	if payload.Issuer == "" {
		return errors.New("payload issuer is required")
	}
	if payload.Audience == "" {
		return errors.New("payload audience is required")
	}
	if payload.Nonce == "" {
		return errors.New("payload nonce is required")
	}
	if payload.ClientFingerprintHash == "" {
		return errors.New("payload client_fingerprint_hash is required")
	}

	return nil
}
