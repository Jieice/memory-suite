/**
 * Optional Redis-backed chat queue for Manager.
 * When REDIS_URL and MANAGER_CHAT_USE_QUEUE=true, POST /api/chat can push to this queue
 * and a background consumer forwards to the unified runtime.
 */

const axios = require('axios');

let redisClient = null;
let consumerInterval = null;

const REDIS_URL = (process.env.REDIS_URL || '').trim();
const MU_URL = process.env.MEMORY_SUITE_URL || process.env.MEMORY_UNIVERSE_URL || 'http://localhost:8080';
const CHAT_QUEUE_KEY = process.env.MANAGER_CHAT_QUEUE_KEY || 'memory:chat:queue';
const CHAT_QUEUE_POLL_MS = Math.max(200, parseInt(process.env.MANAGER_CHAT_QUEUE_POLL_MS || '500', 10));
const CHAT_PROXY_TIMEOUT_MS = parseInt(process.env.MANAGER_CHAT_PROXY_TIMEOUT_MS || '45000', 10) || 45000;

function getChatQueueClient() {
  return redisClient;
}

async function initRedisChatQueue() {
  if (!REDIS_URL) return;
  try {
    const { createClient } = require('redis');
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.warn('[Redis]', err.message));
    await redisClient.connect();
    console.log('[Manager] Redis chat queue connected, key=' + CHAT_QUEUE_KEY);

    consumerInterval = setInterval(async () => {
      if (!redisClient) return;
      try {
        const raw = await redisClient.rPop(CHAT_QUEUE_KEY);
        if (!raw) return;
        const body = JSON.parse(raw);
        await axios({
          method: 'POST',
          url: `${MU_URL}/api/chat`,
          data: body,
          headers: body.requestId ? { 'x-request-id': body.requestId } : {},
          timeout: CHAT_PROXY_TIMEOUT_MS,
          validateStatus: () => true
        });
      } catch (e) {
        if (redisClient) console.warn('[Manager] Chat queue consumer error:', e.message);
      }
    }, CHAT_QUEUE_POLL_MS);
  } catch (e) {
    console.warn('[Manager] Redis chat queue init failed:', e.message);
    redisClient = null;
  }
}

function stopRedisChatQueue() {
  if (consumerInterval) {
    clearInterval(consumerInterval);
    consumerInterval = null;
  }
  if (redisClient) {
    redisClient.quit().catch(() => {});
    redisClient = null;
  }
}

module.exports = { getChatQueueClient, initRedisChatQueue, stopRedisChatQueue };
