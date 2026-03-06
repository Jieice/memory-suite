import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DANMAKU_LOG = path.join(ROOT, 'memory-danmaku', 'logs', 'danmaku-out.log');
const REPORT_DIR = path.join(ROOT, 'reports', 'learning');
const DATA_DIR = path.join(ROOT, 'data', 'training');
const DATA_FILE = path.join(DATA_DIR, 'nightly-samples.jsonl');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_FILE = path.join(REPORT_DIR, `nightly-learning-${stamp}.json`);
const REPORT_MD_FILE = path.join(REPORT_DIR, `nightly-learning-${stamp}.md`);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readRecentLines(filePath, maxLines = 4000) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function extractDanmakuSamples(lines) {
  const samples = [];
  for (const line of lines) {
    const matched = line.match(/(?:收到弹幕|danmaku(?:\s+received)?):\s*\[[^\]]*\]\s*(.+)$/i);
    if (!matched) continue;
    const text = (matched[1] || '').trim();
    if (!text) continue;
    samples.push({
      timestamp: Date.now(),
      text,
      source: 'danmaku'
    });
  }
  return samples;
}

function appendJsonl(filePath, records) {
  if (!records.length) return;
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, payload, 'utf8');
}

function topTerms(samples, topN = 15) {
  const freq = new Map();
  for (const s of samples) {
    const terms = (s.text.match(/[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}|[0-9]{2,}/g) || [])
      .map((v) => v.toLowerCase());
    for (const t of terms) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term, count]) => ({ term, count }));
}

function writeMarkdownReport(report) {
  const lines = [
    '# Nightly Learning Report',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- scannedLines: ${report.scannedLines}`,
    `- extractedSamples: ${report.extractedSamples}`,
    `- dataset: ${report.output.dataset}`,
    '',
    '## Top Terms',
    ...(report.topTerms.length > 0
      ? report.topTerms.map((item) => `- ${item.term}: ${item.count}`)
      : ['- (none)']),
    ''
  ];
  fs.writeFileSync(REPORT_MD_FILE, lines.join('\n'), 'utf8');
}

function main() {
  ensureDir(REPORT_DIR);
  ensureDir(DATA_DIR);

  const lines = readRecentLines(DANMAKU_LOG);
  const samples = extractDanmakuSamples(lines);
  appendJsonl(DATA_FILE, samples);

  const report = {
    success: true,
    mode: 'nightly-lightweight-learning',
    generatedAt: new Date().toISOString(),
    sourceLog: path.relative(ROOT, DANMAKU_LOG),
    scannedLines: lines.length,
    extractedSamples: samples.length,
    topTerms: topTerms(samples),
    output: {
      dataset: path.relative(ROOT, DATA_FILE),
      reportJson: path.relative(ROOT, REPORT_FILE),
      reportMarkdown: path.relative(ROOT, REPORT_MD_FILE)
    }
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  writeMarkdownReport(report);
  console.log(`[NightlyLearn] samples=${samples.length} report=${report.output.reportJson}`);
  console.log(`[NightlyLearn] markdown=${report.output.reportMarkdown}`);
}

main();
