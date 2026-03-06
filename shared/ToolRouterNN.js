class ToolRouterNN {
  scoreSchema(userText, schema) {
    const text = (userText || '').toLowerCase();
    const schemaText = JSON.stringify(schema || {}).toLowerCase();
    if (!text || !schemaText) return 0;

    const tokens = text.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    if (tokens.length === 0) return 0;

    let score = 0;
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (schemaText.includes(token)) score += 1;
    }
    return score;
  }

  async route(context, schemas) {
    const userText = String(context?.userText || '');
    const list = Array.isArray(schemas) ? schemas : [];

    if (!userText || list.length === 0) {
      return {
        selectedTool: null,
        confidence: 0,
        reason: 'No user text or enabled tool schemas.',
        candidates: []
      };
    }

    const scored = list.map((schema) => {
      const score = this.scoreSchema(userText, schema);
      return {
        toolId: schema?.toolId || null,
        name: schema?.name || schema?.title || schema?.toolId || 'unknown',
        score
      };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const total = scored.reduce((sum, item) => sum + item.score, 0);
    const confidence = total > 0 ? best.score / total : 0;

    return {
      selectedTool: best?.toolId || null,
      confidence: Number(confidence.toFixed(3)),
      reason: best?.score > 0 ? 'Keyword overlap with enabled schemas.' : 'No meaningful schema match.',
      candidates: scored.slice(0, 5)
    };
  }
}

module.exports = { ToolRouterNN };
