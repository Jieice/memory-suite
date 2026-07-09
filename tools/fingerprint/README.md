# Browser Fingerprint Collector

This tool launches Playwright headless Chromium, collects browser fingerprint signals, and writes one JSON object to stdout.

## Install

```powershell
cd tools\fingerprint
npm install
npx playwright install chromium
```

## Run

```powershell
node fingerprint.js > fingerprint.json
```

The script records errors per collector instead of failing the whole run when a browser capability is unavailable. For example, WebRTC or WebGL may emit an `error` field in restricted headless environments while the rest of the JSON remains usable.

## Use With The Go CLI

```powershell
cd ..\..
go run .\cmd\kiro -- run --config .\cmd\kiro\config.example.json --fingerprint .\tools\fingerprint\fingerprint.json --jwk .\public.jwk.json --out .\result.json
```

The CLI compacts this JSON, computes `sha256:<hex>` over it, and exposes both the parsed fields and hash to workflow templates.

Common template variables:

```text
{{.fingerprint.userAgent}}
{{.fingerprint.language}}
{{.fingerprint_hash}}
```
