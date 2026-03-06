import fs from 'fs';
import path from 'path';

const TRACE_PATH =
  process.env.COT_TRACE_PATH ||
  path.resolve(process.cwd(), 'data', 'traces', 'cot_traces.jsonl');

function readLines(filePath, maxLines = 20000) {
  if (!fs.existsSync(filePath)) {
    console.error(`[CoT-Analyze] 文件不存在: ${filePath}`);
    process.exit(1);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length > maxLines) {
    return lines.slice(-maxLines);
  }
  return lines;
}

function main() {
  try {
    const lines = readLines(TRACE_PATH);
    if (lines.length === 0) {
      console.log('[CoT-Analyze] 没有可用的 trace 记录。');
      return;
    }

    let total = 0;
    let parseOk = 0;
    let byRoute = {};
    let byProvider = {};

    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      total += 1;
      const ok = !!rec.parse_ok;
      if (ok) parseOk += 1;

      const route = rec.route || 'unknown';
      const provider = rec.llmProvider || rec.llm_provider || 'unknown';

      if (!byRoute[route]) {
        byRoute[route] = { total: 0, parseOk: 0 };
      }
      byRoute[route].total += 1;
      if (ok) byRoute[route].parseOk += 1;

      if (!byProvider[provider]) {
        byProvider[provider] = { total: 0, parseOk: 0 };
      }
      byProvider[provider].total += 1;
      if (ok) byProvider[provider].parseOk += 1;
    }

    if (total === 0) {
      console.log('[CoT-Analyze] 没有有效的 JSON 行。');
      return;
    }

    const ratio = (parseOk / total) * 100;
    console.log('==== CoT JSON 解析情况（最近样本）====');
    console.log(`总样本数: ${total}`);
    console.log(`解析成功: ${parseOk} (${ratio.toFixed(2)}%)`);

    console.log('\n按 route 统计:');
    for (const [route, stat] of Object.entries(byRoute)) {
      const r = (stat.parseOk / stat.total) * 100;
      console.log(`  ${route}: ${stat.parseOk}/${stat.total} (${r.toFixed(2)}%)`);
    }

    console.log('\n按 provider 统计:');
    for (const [prov, stat] of Object.entries(byProvider)) {
      const r = (stat.parseOk / stat.total) * 100;
      console.log(`  ${prov}: ${stat.parseOk}/${stat.total} (${r.toFixed(2)}%)`);
    }
  } catch (err) {
    console.error('[CoT-Analyze] 解析失败:', err.message || err);
    process.exit(1);
  }
}

main();

