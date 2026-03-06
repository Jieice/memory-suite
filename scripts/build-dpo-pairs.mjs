#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const cwd = process.cwd();
const args = process.argv.slice(2);

const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
};

const inputPath = path.resolve(cwd, getArg('--input', 'memory-universe/data/memories/memories.json'));
const outputPath = path.resolve(cwd, getArg('--out', 'data/dpo/anime_pairs.jsonl'));
const statsPath = path.resolve(cwd, getArg('--stats', 'data/dpo/anime_pairs.stats.json'));
const maxPairs = Number.parseInt(getArg('--max-pairs', '6000'), 10) || 6000;
const minChars = Number.parseInt(getArg('--min-chars', '4'), 10) || 4;
const maxChars = Number.parseInt(getArg('--max-chars', '180'), 10) || 180;
const onlyZh = getArg('--only-zh', 'true') !== 'false';

const BAD_REPLY_PATTERNS = [
  /AI service temporarily unavailable/i,
  /抱歉，我刚刚掉线了/,
  /抱歉，我遇到了问题/,
  /唔\.\.\.脑子有点卡壳/,
  /请告诉创造者/,
  /<think>/i,
  /^\.{3,}$/i,
  /follow-up:/i,
  /as an ai/i,
  /作为ai/i,
  /你刚刚说.*对吧[？?]?$/
];

const DEFAULT_REJECTED = [
  '抱歉，我刚刚掉线了，请再说一次。',
  '嗯？你刚刚说的我没太明白。',
  '我现在不太确定，稍后再说。'
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = normalizeText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isMostlyEnglish(text) {
  const sample = normalizeText(text);
  if (!sample) return false;
  const cjkCount = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (sample.match(/[A-Za-z]/g) || []).length;
  if (latinCount === 0) return false;
  return cjkCount === 0 || latinCount > cjkCount * 2;
}

function extractTurn(record) {
  const content = normalizeText(record?.content);
  const responseText = normalizeText(record?.metadata?.responseText);
  const source = normalizeText(record?.metadata?.source || 'unknown').toLowerCase();
  const timestamp = Number(record?.timestamp || 0);

  if (!content && !responseText) return null;

  const separator = content.includes('→ 回复:')
    ? '→ 回复:'
    : (content.includes('-> 回复:') ? '-> 回复:' : null);

  let userText = '';
  let replyText = responseText;
  if (separator) {
    const idx = content.indexOf(separator);
    userText = content.slice(0, idx).trim();
    if (!replyText) {
      replyText = content.slice(idx + separator.length).trim();
    }
  } else {
    userText = content;
  }

  userText = userText
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/^\([^)]+\)\s*/g, '')
    .trim();

  return {
    source,
    userText: normalizeText(userText),
    replyText: normalizeText(replyText),
    timestamp
  };
}

function isBadReply(reply) {
  const text = normalizeText(reply);
  if (!text) return true;
  if (text.length < minChars || text.length > maxChars) return true;
  if (text.startsWith('/')) return true;
  for (const pattern of BAD_REPLY_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function pickSourceHint(sourceStats) {
  const entries = Object.entries(sourceStats).sort((a, b) => b[1] - a[1]);
  return entries.length > 0 ? entries[0][0] : 'unknown';
}

function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const memories = Array.isArray(raw?.memories) ? raw.memories : [];

  const groups = new Map();
  const globalBadPool = [];
  const counters = {
    totalRecords: 0,
    parsedTurns: 0,
    skippedNoText: 0,
    skippedLang: 0,
    goodTurns: 0,
    badTurns: 0,
    pairs: 0
  };

  for (const row of memories) {
    counters.totalRecords += 1;
    const record = Array.isArray(row) ? row[1] : row;
    const turn = extractTurn(record);
    if (!turn || !turn.userText || !turn.replyText) {
      counters.skippedNoText += 1;
      continue;
    }
    counters.parsedTurns += 1;

    if (onlyZh && (isMostlyEnglish(turn.userText) || isMostlyEnglish(turn.replyText))) {
      counters.skippedLang += 1;
      continue;
    }

    const key = normalizeText(turn.userText).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        prompt: turn.userText,
        good: [],
        bad: [],
        sourceStats: {}
      });
    }
    const group = groups.get(key);
    group.sourceStats[turn.source] = (group.sourceStats[turn.source] || 0) + 1;

    if (isBadReply(turn.replyText)) {
      group.bad.push(turn.replyText);
      globalBadPool.push(turn.replyText);
      counters.badTurns += 1;
    } else {
      group.good.push(turn.replyText);
      counters.goodTurns += 1;
    }
  }

  const cleanBadPool = dedupe([...globalBadPool, ...DEFAULT_REJECTED]);
  const pairs = [];
  const profileStats = { creator: 0, public: 0 };

  for (const [key, group] of groups.entries()) {
    if (pairs.length >= maxPairs) break;

    const goodReplies = dedupe(group.good);
    const badReplies = dedupe(group.bad);
    if (goodReplies.length === 0) continue;

    const sourceHint = pickSourceHint(group.sourceStats);
    const rejectedFallback = badReplies[0] || cleanBadPool[0] || DEFAULT_REJECTED[0];

    for (const chosen of goodReplies.slice(0, 2)) {
      if (pairs.length >= maxPairs) break;
      let rejected = rejectedFallback;
      if (chosen === rejected) {
        const alt = cleanBadPool.find((x) => x && x !== chosen);
        if (!alt) continue;
        rejected = alt;
      }
      if (!rejected || rejected === chosen) continue;

      const isCreator = sourceHint === 'creator';
      if (isCreator) profileStats.creator += 1;
      else profileStats.public += 1;

      pairs.push({
        prompt: group.prompt,
        chosen,
        rejected,
        metadata: {
          key,
          source: sourceHint,
          sourceStats: group.sourceStats
        }
      });
    }
  }

  counters.pairs = pairs.length;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    pairs.map((item) => JSON.stringify(item)).join('\n') + (pairs.length > 0 ? '\n' : ''),
    'utf8'
  );

  const stats = {
    generatedAt: new Date().toISOString(),
    inputPath,
    outputPath,
    options: { maxPairs, minChars, maxChars, onlyZh },
    counters,
    groups: groups.size,
    pool: {
      badPoolSize: cleanBadPool.length
    },
    splits: profileStats
  };

  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');

  console.log(`[DPO-Pairs] turns=${counters.parsedTurns} good=${counters.goodTurns} bad=${counters.badTurns}`);
  console.log(`[DPO-Pairs] pairs=${pairs.length} groups=${groups.size}`);
  console.log(`[DPO-Pairs] output=${outputPath}`);
  console.log(`[DPO-Pairs] stats=${statsPath}`);
}

main();

