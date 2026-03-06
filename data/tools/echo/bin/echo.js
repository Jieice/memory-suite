#!/usr/bin/env node

// Simple echo tool for testing
const fs = require('fs');

function readArgs() {
  const argsPath = process.env.TOOL_ARGS_PATH;
  if (argsPath && fs.existsSync(argsPath)) {
    try {
      return JSON.parse(fs.readFileSync(argsPath, 'utf-8'));
    } catch {
      // ignore
    }
  }
  try {
    return JSON.parse(process.argv[2] || process.env.TOOL_ARGS_JSON || '{}');
  } catch {
    return {};
  }
}

const args = readArgs();

const result = {
  echoed: args.message || '',
  timestamp: new Date().toISOString(),
  callId: process.env.TOOL_CALL_ID
};

console.log(JSON.stringify(result));
