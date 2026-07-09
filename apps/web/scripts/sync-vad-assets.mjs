// Copies offline VAD assets (Silero ONNX model, worklet, onnxruntime wasm) from
// node_modules into public/vad so the voice loop runs fully offline with no CDN.
// Run automatically before dev/build; safe to re-run.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const target = join(webRoot, 'public', 'vad');

// onnxruntime-web is pinned to 1.19.2 because vad-web@0.0.30 loads the classic
// `ort-wasm-simd-threaded[.jsep].mjs` glue, which fetches a matching
// `ort-wasm-simd-threaded[.jsep].wasm`. onnxruntime-web 1.27 dropped those and
// ships only `*.asyncify.wasm`, so the runtime 404s on the wasm and dies with
// "no available backend found". Keep the mjs + its companion wasm in lockstep.
const assets = [
  ['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', 'silero_vad_legacy.onnx'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.wasm'],
];

await mkdir(target, { recursive: true });

let copied = 0;
let missing = 0;
for (const [from, to] of assets) {
  const src = join(webRoot, from);
  if (!existsSync(src)) {
    console.warn(`[sync-vad-assets] missing source, skipped: ${from}`);
    missing += 1;
    continue;
  }
  await copyFile(src, join(target, to));
  copied += 1;
}

console.log(`[sync-vad-assets] copied ${copied} asset(s) to public/vad${missing ? `, ${missing} missing` : ''}`);
if (missing) {
  process.exitCode = 1;
}
