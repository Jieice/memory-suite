package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"memory-suite/tools/fsm"
	"memory-suite/tools/jwe-envelope/envelope"
	"memory-suite/tools/rpc"
)

func TestKiroRunEndToEnd(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	tempDir := t.TempDir()
	fingerprintPath := writeTestFile(t, tempDir, "fingerprint.json", `{
	  "navigator": {
	    "user_agent": "TestAgent/1.0",
	    "language": "en-US",
	    "platform": "test-platform"
	  },
	  "screen": {
	    "width": 1280,
	    "height": 720
	  }
	}`)
	jwkPath := writeTestFile(t, tempDir, "public.jwk.json", string(publicJWKJSON(t, &privateKey.PublicKey)))

	var startSeen bool
	var challengeSeen bool
	var pollCount int

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/register/start":
			startSeen = true
			if request.Method != http.MethodPost {
				t.Fatalf("start method = %s", request.Method)
			}
			if got := request.Header.Get("User-Agent"); got != "TestAgent/1.0" {
				t.Fatalf("user-agent = %q, want TestAgent/1.0", got)
			}

			var body struct {
				FingerprintHash string            `json:"fingerprint_hash"`
				Envelope        envelope.Envelope `json:"envelope"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode start body: %v", err)
			}
			if !strings.HasPrefix(body.FingerprintHash, "sha256:") {
				t.Fatalf("fingerprint hash = %q", body.FingerprintHash)
			}
			payload, err := envelope.OpenPayload(privateKey, body.Envelope)
			if err != nil {
				t.Fatalf("open JWE payload: %v", err)
			}
			if payload.ClientFingerprintHash != body.FingerprintHash {
				t.Fatalf("payload fingerprint hash = %q, body = %q", payload.ClientFingerprintHash, body.FingerprintHash)
			}

			writer.Header().Set("Content-Type", "application/octet-stream")
			writer.WriteHeader(http.StatusOK)
			writer.Write(rpc.EncodeRegistrationResponse(rpc.RegistrationResponse{
				SessionID:      "session-123",
				ChallengeNonce: []byte("nonce-abc"),
				NextActionURL:  serverURL(request) + "/register/challenge",
			}))
		case "/register/challenge":
			challengeSeen = true
			if got := request.Header.Get("X-Session-ID"); got != "session-123" {
				t.Fatalf("challenge session header = %q, want session-123", got)
			}
			var body map[string]string
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode challenge body: %v", err)
			}
			if body["session_id"] != "session-123" {
				t.Fatalf("challenge session id = %q", body["session_id"])
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusOK)
			writer.Write([]byte(`{"accepted":true}`))
		case "/register/token":
			pollCount++
			writer.Header().Set("Content-Type", "application/json")
			if pollCount == 1 {
				writer.WriteHeader(http.StatusAccepted)
				writer.Write([]byte(`{"status":"pending"}`))
				return
			}
			writer.WriteHeader(http.StatusOK)
			writer.Write([]byte(`{"access_token":"tok_123","refresh_token":"ref_123"}`))
		default:
			t.Fatalf("unexpected request path %s", request.URL.Path)
		}
	}))
	defer server.Close()

	config := testWorkflowConfig(server.URL)
	configPath := writeJSONFile(t, tempDir, "workflow.json", config)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	err = run([]string{
		"run",
		"--config", configPath,
		"--fingerprint", fingerprintPath,
		"--jwk", jwkPath,
	}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("kiro run failed: %v\nstderr: %s", err, stderr.String())
	}
	if !startSeen || !challengeSeen || pollCount != 2 {
		t.Fatalf("start=%v challenge=%v pollCount=%d", startSeen, challengeSeen, pollCount)
	}

	var result WorkflowResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode workflow result: %v\n%s", err, stdout.String())
	}
	if !strings.HasPrefix(result.FingerprintHash, "sha256:") {
		t.Fatalf("result fingerprint hash = %q", result.FingerprintHash)
	}
	if result.Envelope.Protected == "" || result.Envelope.Ciphertext == "" {
		t.Fatal("result envelope is incomplete")
	}
	if len(result.StateHistory) != 3 {
		t.Fatalf("state history length = %d, want 3", len(result.StateHistory))
	}
	if err := fsm.VerifyRecords(result.StateHistory); err != nil {
		t.Fatalf("verify state history: %v", err)
	}
	if got := result.Steps[0].Response.TLV["session_id"]; got != "session-123" {
		t.Fatalf("start TLV session_id = %q", got)
	}
	var tokenBody map[string]string
	if err := json.Unmarshal(result.Steps[2].Response.JSON, &tokenBody); err != nil {
		t.Fatalf("decode token summary JSON: %v", err)
	}
	if tokenBody["access_token"] != "tok_123" {
		t.Fatalf("access token = %q, want tok_123", tokenBody["access_token"])
	}
}

func TestFileFingerprintLoaderCompactsAndHashes(t *testing.T) {
	path := writeTestFile(t, t.TempDir(), "fingerprint.json", "{\n  \"navigator\": {\"user_agent\": \"test\"}\n}\n")

	fingerprint, err := (FileFingerprintLoader{}).Load(context.Background(), path)
	if err != nil {
		t.Fatalf("load fingerprint: %v", err)
	}
	if !strings.HasPrefix(fingerprint.Hash, "sha256:") {
		t.Fatalf("hash = %q, want sha256 prefix", fingerprint.Hash)
	}
	if string(fingerprint.Raw) != `{"navigator":{"user_agent":"test"}}` {
		t.Fatalf("raw = %s", fingerprint.Raw)
	}
	if fingerprint.Values["userAgent"] != "test" {
		t.Fatalf("userAgent alias = %#v", fingerprint.Values["userAgent"])
	}
}

func TestTemplateCanReferenceResponseData(t *testing.T) {
	rendered, err := renderTemplate("{{.responses.start.tlv.next_action_url}}", TemplateContext{
		Responses: map[string]any{
			"start": map[string]any{
				"tlv": map[string]string{"next_action_url": "https://example.test/next"},
			},
		},
	})
	if err != nil {
		t.Fatalf("render template: %v", err)
	}
	if rendered != "https://example.test/next" {
		t.Fatalf("rendered = %q", rendered)
	}
}

func testWorkflowConfig(baseURL string) Config {
	return Config{
		Issuer:       "internal-security-test",
		Audience:     "kiro-registration-validator",
		InitialState: "initialized",
		Headers: map[string]string{
			"User-Agent":         "{{.fingerprint.userAgent}}",
			"Accept-Language":    "{{.fingerprint.language}}",
			"X-Fingerprint-Hash": "{{.fingerprint_hash}}",
		},
		Transitions: []TransitionConfig{
			{State: "initialized", Action: "start_registration", NextState: "registration_started"},
			{State: "registration_started", Action: "submit_challenge", NextState: "challenge_submitted"},
			{State: "challenge_submitted", Action: "poll_token", NextState: "token_ready"},
		},
		Steps: []StepConfig{
			{
				Name:   "start",
				Action: "start_registration",
				Method: http.MethodPost,
				URL:    baseURL + "/register/start",
				Headers: map[string]string{
					"Content-Type": "application/json",
				},
				BodyTemplate: `{"fingerprint_hash":"{{.fingerprint_hash}}","envelope":{{json .envelope}}}`,
				Response: ResponseConfig{
					Format: "tlv",
					TLV: TLVConfig{Handlers: []TLVHandlerConfig{
						{Tag: "0x01", Name: "session_id", Encoding: "string"},
						{Tag: "0x02", Name: "challenge_nonce", Encoding: "base64"},
						{Tag: "0x03", Name: "next_action_url", Encoding: "string"},
					}},
				},
			},
			{
				Name:   "challenge",
				Action: "submit_challenge",
				Method: http.MethodPost,
				URL:    "{{.responses.start.tlv.next_action_url}}",
				Headers: map[string]string{
					"Content-Type": "application/json",
					"X-Session-ID": "{{.responses.start.tlv.session_id}}",
				},
				BodyTemplate: `{"session_id":"{{.responses.start.tlv.session_id}}","challenge_nonce":"{{.responses.start.tlv.challenge_nonce}}"}`,
				Response:     ResponseConfig{Format: "json"},
			},
			{
				Name:     "token",
				Action:   "poll_token",
				Method:   http.MethodGet,
				URL:      baseURL + "/register/token?session_id={{.responses.start.tlv.session_id}}",
				Response: ResponseConfig{Format: "json"},
				Poll: &PollConfig{
					MaxRetries:           3,
					TimeoutSeconds:       5,
					InitialBackoffMillis: 1,
					MaxBackoffMillis:     1,
					Jitter:               0,
					PendingStatusCodes:   []int{http.StatusAccepted},
					SuccessStatusCodes:   []int{http.StatusOK},
					SuccessJSONFields:    []string{"access_token"},
				},
			},
		},
	}
}

func writeJSONFile(t *testing.T, dir, name string, value any) string {
	t.Helper()

	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal %s: %v", name, err)
	}
	return writeTestFile(t, dir, name, string(encoded))
}

func writeTestFile(t *testing.T, dir, name, content string) string {
	t.Helper()

	path := dir + string(os.PathSeparator) + name
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func publicJWKJSON(t *testing.T, publicKey *rsa.PublicKey) []byte {
	t.Helper()

	exponent := big.NewInt(int64(publicKey.E)).Bytes()
	jwk := map[string]string{
		"kty": "RSA",
		"kid": "test-key",
		"use": "enc",
		"alg": envelope.AlgorithmRSAOAEP256,
		"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(exponent),
	}
	encoded, err := json.Marshal(jwk)
	if err != nil {
		t.Fatalf("marshal public JWK: %v", err)
	}
	return encoded
}

func serverURL(request *http.Request) string {
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + request.Host
}
