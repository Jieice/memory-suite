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
const outputPath = path.resolve(cwd, getArg('--out', 'data/lora/anime_sft.jsonl'));
const statsPath = path.resolve(cwd, getArg('--stats', 'data/lora/anime_sft.stats.json'));
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
  /follow-up:/i,
  /as an ai/i,
  /作为AI/
];

const profileRules = [
  { profile: 'tsundere_playful', pattern: /(哼|才不是|别误会|笨蛋|你想多了)/ },
  { profile: 'denpa_chaotic', pattern: /(脑电波|宇宙|次元|乱码|信号|wwww?)/i },
  { profile: 'seiso_gentle', pattern: /(慢慢来|辛苦了|别担心|先休息|抱抱|注意身体)/ }
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTurn(record) {
  const content = normalizeText(record?.content);
  const metaReply = normalizeText(record?.metadata?.responseText);
  const source = normalizeText(record?.metadata?.source || 'unknown').toLowerCase();

  if (!content && !metaReply) return null;

  const separator = content.includes('→ 回复:')
    ? '→ 回复:'
    : (content.includes('-> 回复:') ? '-> 回复:' : null);

  let userText = '';
  let replyText = metaReply;
  if (separator) {
    const splitIndex = content.indexOf(separator);
    userText = content.slice(0, splitIndex).trim();
    if (!replyText) {
      replyText = content.slice(splitIndex + separator.length).trim();
    }
  } else {
    userText = content;
  }

  const userSpeakerTrimmed = userText
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/^\([^)]+\)\s*/g, '')
    .trim();

  return {
    source,
    userText: normalizeText(userSpeakerTrimmed || userText),
    replyText: normalizeText(replyText)
  };
}

function isMostlyEnglish(text) {
  const sample = normalizeText(text);
  if (!sample) return false;
  const cjkCount = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (sample.match(/[A-Za-z]/g) || []).length;
  if (latinCount === 0) return false;
  return cjkCount === 0 || latinCount > cjkCount * 2;
}

function isBadReply(replyText) {
  if (!replyText) return true;
  if (replyText.length < minChars || replyText.length > maxChars) return true;
  if (replyText.startsWith('/')) return true;
  for (const rule of BAD_REPLY_PATTERNS) {
    if (rule.test(replyText)) return true;
  }
  return false;
}

function inferProfile(replyText) {
  for (const rule of profileRules) {
    if (rule.pattern.test(replyText)) return rule.profile;
  }
  return 'moe_balanced';
}

function buildSample(turn) {
  const profile = inferProfile(turn.replyText);
  const systemPrompt = `你是二次元直播角色，使用自然口语；不编造状态，不输出模板腔。style=${profile}`;
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: turn.userText },
      { role: 'assistant', content: turn.replyText }
    ],
    metadata: {
      source: turn.source,
      profile,
      language: 'zh'
    }
  };
}

function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const memories = Array.isArray(raw?.memories) ? raw.memories : [];

  let total = 0;
  let accepted = 0;
  let rejected = 0;
  let rejectedBadReply = 0;
  let rejectedLanguage = 0;
  const sourceStats = {};
  const profileStats = {};
  const samples = [];

  for (const item of memories) {
    total += 1;
    const record = Array.isArray(item) ? item[1] : item;
    const turn = extractTurn(record);
    if (!turn) {
      rejected += 1;
      continue;
    }
    if (!turn.userText || !turn.replyText) {
      rejected += 1;
      rejectedBadReply += 1;
      continue;
    }
    if (isBadReply(turn.replyText)) {
      rejected += 1;
      rejectedBadReply += 1;
      continue;
    }
    if (onlyZh && (isMostlyEnglish(turn.userText) || isMostlyEnglish(turn.replyText))) {
      rejected += 1;
      rejectedLanguage += 1;
      continue;
    }

    const sample = buildSample(turn);
    samples.push(sample);
    accepted += 1;
    sourceStats[turn.source] = (sourceStats[turn.source] || 0) + 1;
    profileStats[sample.metadata.profile] = (profileStats[sample.metadata.profile] || 0) + 1;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    samples.map((line) => JSON.stringify(line)).join('\n') + (samples.length > 0 ? '\n' : ''),
    'utf8'
  );

  const stats = {
    generatedAt: new Date().toISOString(),
    inputPath,
    outputPath,
    options: { minChars, maxChars, onlyZh },
    counts: {
      total,
      accepted,
      rejected,
      rejectedBadReply,
      rejectedLanguage
    },
    bySource: sourceStats,
    byProfile: profileStats
  };

  fs.mkdirSync(path.dirname(statsPath), { recursive: true });
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');

  console.log(`[LoRA-Corpus] total=${total} accepted=${accepted} rejected=${rejected}`);
  console.log(`[LoRA-Corpus] bySource=${JSON.stringify(sourceStats)}`);
  console.log(`[LoRA-Corpus] byProfile=${JSON.stringify(profileStats)}`);
  console.log(`[LoRA-Corpus] jsonl=${outputPath}`);
  console.log(`[LoRA-Corpus] stats=${statsPath}`);
}

main();

