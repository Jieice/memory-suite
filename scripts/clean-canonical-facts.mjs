import fs from 'fs';
import path from 'path';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    '-',
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds())
  ].join('');
}

function normalizeFactText(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,。.!！?？;；:：\-\s]+/, '')
    .replace(/[，,。.!！?？;；:：\-\s]+$/, '')
    .trim();
}

function hasSignalChars(text) {
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(text || '');
}

function shouldDropFact(fact, preferredName) {
  const text = normalizeFactText(fact);
  if (!text) return { drop: true, reason: 'empty' };
  if (text.length < 3) return { drop: true, reason: 'too_short' };
  if (!hasSignalChars(text)) return { drop: true, reason: 'no_signal' };
  if (/[?？]/.test(text)) return { drop: true, reason: 'question_like' };

  if (/^(我叫|我是|叫我|你可以叫我|请叫我)\s*[A-Za-z0-9_\-\u4e00-\u9fff]{1,24}$/i.test(text)) {
    return { drop: true, reason: 'name_intro' };
  }
  if (/^(my name is|call me)\s+[A-Za-z][A-Za-z0-9_\-]{0,23}$/i.test(text)) {
    return { drop: true, reason: 'name_intro' };
  }

  if (preferredName) {
    const escaped = preferredName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(我叫|我是|my name is|call me)\\s*${escaped}$`, 'i');
    if (re.test(text)) return { drop: true, reason: 'redundant_name_fact' };
  }

  if (/(喜欢|不喜欢|偏好|讨厌|热爱|avoid|prefer|dislike|hate|i like|i don't like)/i.test(text)) {
    return { drop: true, reason: 'preference_like' };
  }
  if (/^(todo|待办|任务|计划|下一步)\s*[:：]/i.test(text)) {
    return { drop: true, reason: 'task_like' };
  }

  if (/^([我你他她它]|i|you)\s*(叫什么|是谁|名字|name)\b/i.test(text)) {
    return { drop: true, reason: 'identity_question_like' };
  }
  if (
    /(吗|么|呢|吧)$/.test(text) &&
    /(名字|城市|是谁|叫什么|name|city|who|what|where|when|how)/i.test(text)
  ) {
    return { drop: true, reason: 'question_fragment' };
  }

  return { drop: false, reason: '' };
}

function main() {
  const inputArg = process.argv[2] || 'data/canonical-memory.json';
  const filePath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(filePath)) {
    throw new Error(`canonical file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || !payload.users || typeof payload.users !== 'object') {
    throw new Error('invalid canonical-memory structure');
  }

  const stamp = buildStamp();
  const backupPath = path.join(path.dirname(filePath), `canonical-memory.backup-${stamp}.json`);
  fs.writeFileSync(backupPath, raw, 'utf8');

  const reasonCounter = new Map();
  let usersTouched = 0;
  let removedCount = 0;
  let keptCount = 0;

  for (const [userId, user] of Object.entries(payload.users)) {
    const facts = Array.isArray(user?.facts) ? user.facts : [];
    if (facts.length === 0) continue;
    const preferredName = (user?.preferredName || '').toString().trim();

    const next = [];
    const seen = new Set();
    for (const fact of facts) {
      const text = normalizeFactText(fact);
      const decision = shouldDropFact(text, preferredName);
      if (decision.drop) {
        removedCount += 1;
        reasonCounter.set(decision.reason, (reasonCounter.get(decision.reason) || 0) + 1);
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(text);
      keptCount += 1;
    }

    if (next.length !== facts.length) {
      usersTouched += 1;
      payload.users[userId].facts = next;
      payload.users[userId].updatedAt = Date.now();
    } else if (next.some((x, idx) => x !== facts[idx])) {
      usersTouched += 1;
      payload.users[userId].facts = next;
      payload.users[userId].updatedAt = Date.now();
    }
  }

  payload.savedAt = Date.now();
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

  const reasons = Object.fromEntries(
    Array.from(reasonCounter.entries()).sort((a, b) => b[1] - a[1])
  );
  console.log(JSON.stringify({
    filePath,
    backupPath,
    usersTouched,
    removedCount,
    keptCount,
    reasons
  }, null, 2));
}

main();
