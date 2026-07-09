package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
)

type JWK struct {
	KTY string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
	Kid string `json:"kid,omitempty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
}

func main() {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}

	jwk := JWK{
		KTY: "RSA",
		N:   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		Kid: "kiro-test-key",
		Alg: "RSA-OAEP-256",
		Use: "enc",
	}

	pubjwk, _ := json.MarshalIndent(jwk, "", "  ")
	if err := os.WriteFile("public.jwk.json", pubjwk, 0644); err != nil {
		panic(err)
	}

	privDer := x509.MarshalPKCS1PrivateKey(key)
	privPem := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: privDer})
	if err := os.WriteFile("private.pem", privPem, 0600); err != nil {
		panic(err)
	}

	fmt.Println("Generated: public.jwk.json, private.pem")
}