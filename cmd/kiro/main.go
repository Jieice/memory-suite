package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"text/template"
	"time"

	"memory-suite/tools/fsm"
	"memory-suite/tools/jwe-envelope/envelope"
	"memory-suite/tools/poller"
	"memory-suite/tools/rpc"
)

type Fingerprint struct {
	Hash   string
	Raw    json.RawMessage
	Values map[string]any
}

type FingerprintLoader interface {
	Load(ctx context.Context, path string) (Fingerprint, error)
}

type EnvelopeBuilder interface {
	Seal(publicJWKJSON []byte, payload envelope.Payload) (envelope.Envelope, error)
}

type Config struct {
	Issuer       string             `json:"issuer"`
	Audience     string             `json:"audience"`
	Nonce        string             `json:"nonce,omitempty"`
	InitialState string             `json:"initial_state"`
	Transitions  []TransitionConfig `json:"transitions"`
	Steps        []StepConfig       `json:"steps"`
	Headers      map[string]string  `json:"headers,omitempty"`
}

type TransitionConfig struct {
	State     string `json:"state"`
	Action    string `json:"action"`
	NextState string `json:"next_state"`
}

type StepConfig struct {
	Name         string            `json:"name"`
	Action       string            `json:"action"`
	Method       string            `json:"method"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers,omitempty"`
	BodyTemplate string            `json:"body_template,omitempty"`
	Response     ResponseConfig    `json:"response,omitempty"`
	Poll         *PollConfig       `json:"poll,omitempty"`
}

type ResponseConfig struct {
	Format string    `json:"format,omitempty"`
	TLV    TLVConfig `json:"tlv,omitempty"`
}

type TLVConfig struct {
	Handlers []TLVHandlerConfig `json:"handlers,omitempty"`
}

type TLVHandlerConfig struct {
	Tag      string `json:"tag"`
	Name     string `json:"name"`
	Encoding string `json:"encoding,omitempty"`
}

type PollConfig struct {
	MaxRetries              int      `json:"max_retries"`
	TimeoutSeconds          int      `json:"timeout_seconds"`
	InitialBackoffMillis    int      `json:"initial_backoff_millis"`
	MaxBackoffMillis        int      `json:"max_backoff_millis"`
	Jitter                  float64  `json:"jitter"`
	SuccessStatusCodes      []int    `json:"success_status_codes,omitempty"`
	PendingStatusCodes      []int    `json:"pending_status_codes,omitempty"`
	SuccessJSONFields       []string `json:"success_json_fields,omitempty"`
	SuccessTokenField       string   `json:"success_token_field,omitempty"`
	SuccessRefreshField     string   `json:"success_refresh_field,omitempty"`
	SuccessAccessTokenField string   `json:"success_access_token_field,omitempty"`
}

type WorkflowResult struct {
	FingerprintHash string                 `json:"fingerprint_hash"`
	Envelope        envelope.Envelope      `json:"envelope"`
	StateHistory    []fsm.TransitionRecord `json:"state_history"`
	Steps           []StepResult           `json:"steps"`
}

type StepResult struct {
	Name     string           `json:"name"`
	Action   string           `json:"action"`
	Response *ResponseSummary `json:"response,omitempty"`
}

type ResponseSummary struct {
	StatusCode int               `json:"status_code"`
	Headers    map[string]string `json:"headers,omitempty"`
	JSON       json.RawMessage   `json:"json,omitempty"`
	BodyBase64 string            `json:"body_base64,omitempty"`
	TLV        map[string]string `json:"tlv,omitempty"`
}

type TemplateContext struct {
	Fingerprint     map[string]any `json:"fingerprint"`
	FingerprintHash string         `json:"fingerprint_hash"`
	Envelope        map[string]any `json:"envelope"`
	Responses       map[string]any `json:"responses"`
}

type FileFingerprintLoader struct{}

type JWEEnvelopeBuilder struct{}

type WorkflowDependencies struct {
	Config            Config
	FingerprintPath   string
	PublicJWKJSON     []byte
	FingerprintLoader FingerprintLoader
	EnvelopeBuilder   EnvelopeBuilder
	HTTPClient        poller.HTTPClient
	Sleep             poller.SleepFunc
	Rand              poller.JitterFunc
	Now               func() time.Time
}

type flowState string

func (s flowState) ID() string {
	return string(s)
}

type flowAction string

func (a flowAction) Name() string {
	return string(a)
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		writeUsage(stderr)
		return errors.New("missing command")
	}

	switch args[0] {
	case "run":
		return runWorkflowCommand(args[1:], stdout, stderr)
	case "-h", "--help", "help":
		writeUsage(stdout)
		return nil
	default:
		writeUsage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runWorkflowCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("kiro run", flag.ContinueOnError)
	flags.SetOutput(stderr)

	configPath := flags.String("config", "", "Path to workflow config JSON")
	fingerprintPath := flags.String("fingerprint", "", "Path to fingerprint JSON from tools/fingerprint")
	jwkPath := flags.String("jwk", "", "Path to RSA public JWK JSON")
	outputPath := flags.String("out", "", "Optional output file. Defaults to stdout")

	if err := flags.Parse(args); err != nil {
		return err
	}
	if *configPath == "" {
		return errors.New("--config is required")
	}
	if *fingerprintPath == "" {
		return errors.New("--fingerprint is required")
	}
	if *jwkPath == "" {
		return errors.New("--jwk is required")
	}

	config, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if err := validateConfig(config); err != nil {
		return err
	}

	publicJWKJSON, err := os.ReadFile(*jwkPath)
	if err != nil {
		return fmt.Errorf("read JWK file: %w", err)
	}

	result, err := executeWorkflow(context.Background(), WorkflowDependencies{
		Config:            config,
		FingerprintPath:   *fingerprintPath,
		PublicJWKJSON:     publicJWKJSON,
		FingerprintLoader: FileFingerprintLoader{},
		EnvelopeBuilder:   JWEEnvelopeBuilder{},
		HTTPClient:        http.DefaultClient,
		Now:               time.Now,
	})
	if err != nil {
		return err
	}

	output, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal workflow result: %w", err)
	}
	output = append(output, '\n')

	if *outputPath != "" {
		return os.WriteFile(*outputPath, output, 0600)
	}

	_, err = stdout.Write(output)
	return err
}

func executeWorkflow(ctx context.Context, deps WorkflowDependencies) (WorkflowResult, error) {
	config := deps.Config.withDefaults()
	if err := validateConfig(config); err != nil {
		return WorkflowResult{}, err
	}
	deps.Config = config

	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.HTTPClient == nil {
		deps.HTTPClient = http.DefaultClient
	}
	if deps.FingerprintLoader == nil {
		deps.FingerprintLoader = FileFingerprintLoader{}
	}
	if deps.EnvelopeBuilder == nil {
		deps.EnvelopeBuilder = JWEEnvelopeBuilder{}
	}

	machine := buildFlowMachine(config)
	current := fsm.State(flowState(config.InitialState))

	fingerprint, err := deps.FingerprintLoader.Load(ctx, deps.FingerprintPath)
	if err != nil {
		return WorkflowResult{}, err
	}

	nonce := config.Nonce
	if nonce == "" {
		nonce = fingerprint.Hash
	}
	payload := envelope.NewPayload(
		config.Issuer,
		config.Audience,
		nonce,
		fingerprint.Hash,
		deps.Now().UTC(),
	)

	sealed, err := deps.EnvelopeBuilder.Seal(deps.PublicJWKJSON, payload)
	if err != nil {
		return WorkflowResult{}, err
	}

	templateContext := TemplateContext{
		Fingerprint:     fingerprint.Values,
		FingerprintHash: fingerprint.Hash,
		Envelope:        envelopeTemplateMap(sealed),
		Responses:       make(map[string]any),
	}

	result := WorkflowResult{
		FingerprintHash: fingerprint.Hash,
		Envelope:        sealed,
	}

	for _, step := range config.Steps {
		response, err := executeStep(ctx, deps, step, templateContext)
		if err != nil {
			return WorkflowResult{}, fmt.Errorf("step %q: %w", step.Name, err)
		}
		defer response.Body.Close()

		summary, responseData, err := summarizeConfiguredResponse(response, step.Response)
		if err != nil {
			return WorkflowResult{}, fmt.Errorf("step %q response: %w", step.Name, err)
		}

		templateContext.Responses[step.Name] = responseData
		result.Steps = append(result.Steps, StepResult{
			Name:     step.Name,
			Action:   step.Action,
			Response: summary,
		})

		transition, err := machine.ExecuteRecord(current, flowAction(step.Action))
		if err != nil {
			return WorkflowResult{}, fmt.Errorf("step %q state transition: %w", step.Name, err)
		}
		current = transition.State
	}

	history := machine.History()
	if err := fsm.VerifyRecords(history); err != nil {
		return WorkflowResult{}, fmt.Errorf("verify workflow state history: %w", err)
	}
	result.StateHistory = history

	return result, nil
}

func executeStep(ctx context.Context, deps WorkflowDependencies, step StepConfig, templateContext TemplateContext) (*http.Response, error) {
	if step.Poll != nil {
		return pollStep(ctx, deps, step, templateContext)
	}

	return sendConfiguredRequest(ctx, deps.HTTPClient, step, templateContext)
}

func pollStep(ctx context.Context, deps WorkflowDependencies, step StepConfig, templateContext TemplateContext) (*http.Response, error) {
	pollConfig := step.Poll.withDefaults()

	return poller.Poll(ctx, poller.Options{
		URL: step.URL,
		NewRequest: func(ctx context.Context, _ string) (*http.Request, error) {
			return buildRequest(ctx, step, templateContext)
		},
		IsSuccess: func(response *http.Response) (bool, error) {
			return responseMatchesPollSuccess(response, pollConfig)
		},
		Client:         deps.HTTPClient,
		MaxRetries:     pollConfig.MaxRetries,
		Timeout:        time.Duration(pollConfig.TimeoutSeconds) * time.Second,
		InitialBackoff: time.Duration(pollConfig.InitialBackoffMillis) * time.Millisecond,
		MaxBackoff:     time.Duration(pollConfig.MaxBackoffMillis) * time.Millisecond,
		Jitter:         pollConfig.Jitter,
		Sleep:          deps.Sleep,
		Rand:           deps.Rand,
	})
}

func sendConfiguredRequest(ctx context.Context, client poller.HTTPClient, step StepConfig, templateContext TemplateContext) (*http.Response, error) {
	request, err := buildRequest(ctx, step, templateContext)
	if err != nil {
		return nil, err
	}

	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, errors.New("HTTP client returned nil response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		discardAndClose(response)
		return response, fmt.Errorf("HTTP status %d", response.StatusCode)
	}

	return response, nil
}

func buildRequest(ctx context.Context, step StepConfig, templateContext TemplateContext) (*http.Request, error) {
	method := strings.ToUpper(step.Method)
	if method == "" {
		method = http.MethodGet
	}

	url, err := renderTemplate(step.URL, templateContext)
	if err != nil {
		return nil, fmt.Errorf("render URL template: %w", err)
	}

	var body io.Reader
	if step.BodyTemplate != "" {
		renderedBody, err := renderTemplate(step.BodyTemplate, templateContext)
		if err != nil {
			return nil, fmt.Errorf("render body template: %w", err)
		}
		body = strings.NewReader(renderedBody)
	}

	request, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}

	for key, valueTemplate := range step.Headers {
		value, err := renderTemplate(valueTemplate, templateContext)
		if err != nil {
			return nil, fmt.Errorf("render header %q: %w", key, err)
		}
		request.Header.Set(key, value)
	}
	if step.BodyTemplate != "" && request.Header.Get("Content-Type") == "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json, application/octet-stream")
	}

	return request, nil
}

func summarizeConfiguredResponse(response *http.Response, config ResponseConfig) (*ResponseSummary, map[string]any, error) {
	body, err := readAndRestoreBody(response)
	if err != nil {
		return nil, nil, err
	}

	summary := &ResponseSummary{
		StatusCode: response.StatusCode,
		Headers:    flattenHeaders(response.Header),
	}
	responseData := map[string]any{
		"status_code": response.StatusCode,
		"headers":     summary.Headers,
	}

	trimmed := bytes.TrimSpace(body)
	format := strings.ToLower(config.Format)
	if format == "" || format == "auto" {
		if len(trimmed) > 0 && json.Valid(trimmed) {
			format = "json"
		} else if len(config.TLV.Handlers) > 0 {
			format = "tlv"
		} else {
			format = "binary"
		}
	}

	switch format {
	case "json":
		if len(trimmed) == 0 {
			responseData["json"] = map[string]any{}
			return summary, responseData, nil
		}
		if !json.Valid(trimmed) {
			return nil, nil, errors.New("response is not valid JSON")
		}
		var payload any
		if err := json.Unmarshal(trimmed, &payload); err != nil {
			return nil, nil, err
		}
		summary.JSON = append(json.RawMessage(nil), trimmed...)
		responseData["json"] = payload
	case "tlv":
		decoded, err := decodeConfiguredTLV(body, config.TLV)
		if err != nil {
			return nil, nil, err
		}
		summary.TLV = decoded
		responseData["tlv"] = decoded
	case "binary":
		if len(body) > 0 {
			summary.BodyBase64 = base64.StdEncoding.EncodeToString(body)
			responseData["body_base64"] = summary.BodyBase64
		}
	default:
		return nil, nil, fmt.Errorf("unsupported response format %q", config.Format)
	}

	return summary, responseData, nil
}

func decodeConfiguredTLV(body []byte, config TLVConfig) (map[string]string, error) {
	output := make(map[string]string)
	handlers := make(map[byte]rpc.Handler, len(config.Handlers))

	for _, handlerConfig := range config.Handlers {
		tag, err := parseTag(handlerConfig.Tag)
		if err != nil {
			return nil, err
		}
		name := handlerConfig.Name
		if name == "" {
			name = fmt.Sprintf("0x%02x", tag)
		}
		encoding := strings.ToLower(handlerConfig.Encoding)
		if encoding == "" {
			encoding = "base64"
		}

		handlers[tag] = func(field rpc.Field) error {
			value, err := encodeTLVValue(field.Value, encoding)
			if err != nil {
				return err
			}
			output[name] = value
			return nil
		}
	}

	parser := rpc.NewParser(rpc.Options{Handlers: handlers})
	fields, err := parser.Parse(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	for tag, value := range fields {
		key := fmt.Sprintf("0x%02x", tag)
		if _, ok := output[key]; !ok {
			output[key] = base64.StdEncoding.EncodeToString(value)
		}
	}

	return output, nil
}

func responseMatchesPollSuccess(response *http.Response, config PollConfig) (bool, error) {
	if containsStatus(config.PendingStatusCodes, response.StatusCode) {
		return false, nil
	}
	if len(config.SuccessStatusCodes) > 0 && !containsStatus(config.SuccessStatusCodes, response.StatusCode) {
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return false, nil
		}
		return false, fmt.Errorf("poll returned status %d", response.StatusCode)
	}
	if len(config.SuccessStatusCodes) == 0 && (response.StatusCode < 200 || response.StatusCode >= 300) {
		return false, fmt.Errorf("poll returned status %d", response.StatusCode)
	}

	if len(config.SuccessJSONFields) == 0 {
		return true, nil
	}

	body, err := readAndRestoreBody(response)
	if err != nil {
		return false, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return false, nil
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false, fmt.Errorf("parse poll JSON: %w", err)
	}

	for _, fieldPath := range config.SuccessJSONFields {
		value, ok := lookupPath(payload, fieldPath)
		if ok && valuePresent(value) {
			return true, nil
		}
	}

	return false, nil
}

func buildFlowMachine(config Config) *fsm.FSM {
	transitions := make(map[fsm.TransitionKey]fsm.Transition, len(config.Transitions))
	for _, transition := range config.Transitions {
		nextState := flowState(transition.NextState)
		transitions[fsm.Key(transition.State, transition.Action)] = func(fsm.State, fsm.Action) (fsm.State, error) {
			return nextState, nil
		}
	}

	return fsm.New(fsm.Options{Transitions: transitions})
}

func (FileFingerprintLoader) Load(_ context.Context, path string) (Fingerprint, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Fingerprint{}, fmt.Errorf("read fingerprint file: %w", err)
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return Fingerprint{}, fmt.Errorf("parse fingerprint JSON: %w", err)
	}

	var values map[string]any
	if err := json.Unmarshal(compact.Bytes(), &values); err != nil {
		return Fingerprint{}, fmt.Errorf("decode fingerprint JSON: %w", err)
	}
	addFingerprintAliases(values)

	sum := sha256.Sum256(compact.Bytes())
	return Fingerprint{
		Hash:   "sha256:" + hex.EncodeToString(sum[:]),
		Raw:    append(json.RawMessage(nil), compact.Bytes()...),
		Values: values,
	}, nil
}

func (JWEEnvelopeBuilder) Seal(publicJWKJSON []byte, payload envelope.Payload) (envelope.Envelope, error) {
	return envelope.SealPayload(publicJWKJSON, payload, envelope.SealOptions{})
}

func loadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config file: %w", err)
	}

	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("parse config JSON: %w", err)
	}

	config = config.withDefaults()
	return config, nil
}

func validateConfig(config Config) error {
	if config.Issuer == "" {
		return errors.New("config issuer is required")
	}
	if config.Audience == "" {
		return errors.New("config audience is required")
	}
	if config.InitialState == "" {
		return errors.New("config initial_state is required")
	}
	if len(config.Transitions) == 0 {
		return errors.New("config transitions are required")
	}
	if len(config.Steps) == 0 {
		return errors.New("config steps are required")
	}

	seenTransitions := make(map[fsm.TransitionKey]bool, len(config.Transitions))
	for _, transition := range config.Transitions {
		if transition.State == "" || transition.Action == "" || transition.NextState == "" {
			return errors.New("each transition requires state, action, and next_state")
		}
		seenTransitions[fsm.Key(transition.State, transition.Action)] = true
	}

	current := config.InitialState
	for _, step := range config.Steps {
		if step.Name == "" {
			return errors.New("each step requires name")
		}
		if step.Action == "" {
			return fmt.Errorf("step %q requires action", step.Name)
		}
		if step.URL == "" {
			return fmt.Errorf("step %q requires url", step.Name)
		}
		if !seenTransitions[fsm.Key(current, step.Action)] {
			return fmt.Errorf("step %q has no transition from state %q using action %q", step.Name, current, step.Action)
		}
		current = nextStateFor(config.Transitions, current, step.Action)
		if step.Poll != nil {
			if err := validatePollConfig(*step.Poll); err != nil {
				return fmt.Errorf("step %q poll: %w", step.Name, err)
			}
		}
		if err := validateTLVConfig(step.Response.TLV); err != nil {
			return fmt.Errorf("step %q TLV: %w", step.Name, err)
		}
	}

	return nil
}

func (config Config) withDefaults() Config {
	if config.InitialState == "" {
		config.InitialState = "initialized"
	}

	for index := range config.Steps {
		step := &config.Steps[index]
		if step.Method == "" {
			if step.BodyTemplate == "" {
				step.Method = http.MethodGet
			} else {
				step.Method = http.MethodPost
			}
		}
		step.Headers = mergeHeaders(config.Headers, step.Headers)
		if step.Poll != nil {
			pollConfig := step.Poll.withDefaults()
			step.Poll = &pollConfig
		}
	}

	return config
}

func (config PollConfig) withDefaults() PollConfig {
	if config.MaxRetries == 0 {
		config.MaxRetries = 10
	}
	if config.TimeoutSeconds == 0 {
		config.TimeoutSeconds = 120
	}
	if config.InitialBackoffMillis == 0 {
		config.InitialBackoffMillis = 250
	}
	if config.MaxBackoffMillis == 0 {
		config.MaxBackoffMillis = 5000
	}
	if config.Jitter == 0 {
		config.Jitter = 0.2
	}
	if len(config.PendingStatusCodes) == 0 {
		config.PendingStatusCodes = []int{http.StatusAccepted, http.StatusNoContent}
	}
	if len(config.SuccessStatusCodes) == 0 {
		config.SuccessStatusCodes = []int{http.StatusOK}
	}
	if len(config.SuccessJSONFields) == 0 {
		for _, field := range []string{config.SuccessTokenField, config.SuccessRefreshField, config.SuccessAccessTokenField} {
			if field != "" {
				config.SuccessJSONFields = append(config.SuccessJSONFields, field)
			}
		}
	}
	if len(config.SuccessJSONFields) == 0 {
		config.SuccessJSONFields = []string{"token", "refresh_token", "access_token"}
	}

	return config
}

func validatePollConfig(config PollConfig) error {
	if config.MaxRetries < 0 {
		return errors.New("max_retries must be >= 0")
	}
	if config.TimeoutSeconds <= 0 {
		return errors.New("timeout_seconds must be > 0")
	}
	if config.InitialBackoffMillis <= 0 {
		return errors.New("initial_backoff_millis must be > 0")
	}
	if config.MaxBackoffMillis < config.InitialBackoffMillis {
		return errors.New("max_backoff_millis must be >= initial_backoff_millis")
	}
	if config.Jitter < 0 || config.Jitter > 1 {
		return errors.New("jitter must be between 0 and 1")
	}

	return nil
}

func validateTLVConfig(config TLVConfig) error {
	for _, handler := range config.Handlers {
		if handler.Tag == "" {
			return errors.New("handler tag is required")
		}
		if _, err := parseTag(handler.Tag); err != nil {
			return err
		}
		if handler.Name == "" {
			return errors.New("handler name is required")
		}
		switch strings.ToLower(defaultString(handler.Encoding, "base64")) {
		case "base64", "hex", "string", "utf8":
		default:
			return fmt.Errorf("unsupported TLV encoding %q", handler.Encoding)
		}
	}

	return nil
}

func renderTemplate(source string, context TemplateContext) (string, error) {
	parsed, err := template.New("workflow").Option("missingkey=error").Funcs(template.FuncMap{
		"json": func(value any) (string, error) {
			encoded, err := json.Marshal(value)
			if err != nil {
				return "", err
			}
			return string(encoded), nil
		},
		"base64": func(value string) string {
			return base64.StdEncoding.EncodeToString([]byte(value))
		},
	}).Parse(source)
	if err != nil {
		return "", err
	}

	var output bytes.Buffer
	if err := parsed.Execute(&output, map[string]any{
		"fingerprint":      context.Fingerprint,
		"fingerprint_hash": context.FingerprintHash,
		"envelope":         context.Envelope,
		"responses":        context.Responses,
	}); err != nil {
		return "", err
	}

	return output.String(), nil
}

func readAndRestoreBody(response *http.Response) ([]byte, error) {
	if response == nil {
		return nil, errors.New("response is required")
	}
	if response.Body == nil {
		return nil, nil
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(body))

	return body, nil
}

func discardAndClose(response *http.Response) {
	if response == nil || response.Body == nil {
		return
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
}

func encodeTLVValue(value []byte, encoding string) (string, error) {
	switch strings.ToLower(encoding) {
	case "base64", "":
		return base64.StdEncoding.EncodeToString(value), nil
	case "hex":
		return hex.EncodeToString(value), nil
	case "string", "utf8":
		return string(value), nil
	default:
		return "", fmt.Errorf("unsupported TLV encoding %q", encoding)
	}
}

func parseTag(value string) (byte, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return 0, errors.New("tag is required")
	}

	base := 10
	if strings.HasPrefix(normalized, "0x") || strings.HasPrefix(normalized, "0X") {
		base = 16
		normalized = normalized[2:]
	}

	parsed, err := strconv.ParseUint(normalized, base, 8)
	if err != nil {
		return 0, fmt.Errorf("invalid tag %q: %w", value, err)
	}

	return byte(parsed), nil
}

func containsStatus(statuses []int, status int) bool {
	for _, candidate := range statuses {
		if candidate == status {
			return true
		}
	}
	return false
}

func lookupPath(root map[string]any, path string) (any, bool) {
	var current any = root
	for _, segment := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[segment]
		if !ok {
			return nil, false
		}
	}

	return current, true
}

func valuePresent(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return typed != ""
	case []any:
		return len(typed) > 0
	case map[string]any:
		return len(typed) > 0
	default:
		return true
	}
}

func envelopeTemplateMap(sealed envelope.Envelope) map[string]any {
	return map[string]any{
		"protected":     sealed.Protected,
		"encrypted_key": sealed.EncryptedKey,
		"iv":            sealed.IV,
		"ciphertext":    sealed.Ciphertext,
		"tag":           sealed.Tag,
	}
}

func addFingerprintAliases(values map[string]any) {
	navigatorValue, ok := values["navigator"].(map[string]any)
	if !ok {
		return
	}
	if value, ok := navigatorValue["user_agent"]; ok {
		values["userAgent"] = value
	}
	if value, ok := navigatorValue["platform"]; ok {
		values["platform"] = value
	}
	if value, ok := navigatorValue["language"]; ok {
		values["language"] = value
	}
}

func flattenHeaders(headers http.Header) map[string]string {
	if len(headers) == 0 {
		return nil
	}

	output := make(map[string]string, len(headers))
	for key, values := range headers {
		if len(values) == 0 {
			continue
		}
		output[key] = values[0]
	}

	return output
}

func mergeHeaders(global, local map[string]string) map[string]string {
	if len(global) == 0 && len(local) == 0 {
		return nil
	}

	merged := make(map[string]string, len(global)+len(local))
	for key, value := range global {
		merged[key] = value
	}
	for key, value := range local {
		merged[key] = value
	}

	return merged
}

func nextStateFor(transitions []TransitionConfig, state, action string) string {
	for _, transition := range transitions {
		if transition.State == state && transition.Action == action {
			return transition.NextState
		}
	}
	return ""
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func writeUsage(writer io.Writer) {
	fmt.Fprintln(writer, `Usage:
  kiro run --config workflow.json --fingerprint fingerprint.json --jwk public.jwk.json [--out result.json]

Workflow:
  fingerprint.json -> JWE envelope -> configured HTTP steps -> FSM hash-chain -> audit JSON`)
}
