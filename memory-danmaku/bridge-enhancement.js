/**
 * Bridge.js 增强补丁
 * 
 * 添加到 bridge.js 中的功能：
 * 1. 冷场检测 - 自动触发怀旧
 * 2. 续话检测 - 检测关键词自动续话
 * 
 * 使用方法：
 * 1. 复制下面的代码到 bridge.js 的合适位置
 * 2. 在 processMessage 函数中调用 detectContinueIntent
 * 3. 启动 startSilenceDetection
 */

// ============================================
// 1. 添加到文件顶部的配置区域
// ============================================

// 怀旧功能配置
const NOSTALGIA_CONFIG = {
  silenceThreshold: 30000,   // 30秒冷场触发怀旧
  nostalgiaCooldown: 600000, // 10分钟怀旧冷却
  checkInterval: 5000        // 5秒检查一次
};

// 续话关键词
const CONTINUE_PATTERNS = [
  /继续/,
  /接着说/,
  /然后呢/,
  /说完/,
  /刚才说到哪/,
  /刚才讲到/,
  /后来呢/,
  /接下来/,
  /还有呢/,
  /之后呢/
];

// 状态变量
let lastMessageTime = Date.now();
let lastNostalgiaTime = 0;

// ============================================
// 2. 添加检测函数
// ============================================

/**
 * 检测续话意图
 */
function detectContinueIntent(message) {
  return CONTINUE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * 触发续话
 */
async function triggerContinue(userId) {
  try {
    log('🔄 检测到续话意图，触发续话...');
    
    const response = await fetch(`http://127.0.0.1:${MEMORY_PORT}/api/live/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    
    const result = await response.json();
    
    if (result.success && result.reply) {
      log('✅ 续话成功:', result.reply.substring(0, 50) + '...');
      
      // 使用现有的 TTS 和字幕处理
      await processTTSWithSubtitle(result.reply, `continue_${Date.now()}`);
      
      return true;
    }
    
    return false;
  } catch (error) {
    log('❌ 续话失败:', error.message);
    return false;
  }
}

/**
 * 检测冷场并触发怀旧
 */
async function checkSilenceAndNostalgia() {
  if (busy) return; // 如果正在处理消息，跳过
  
  const now = Date.now();
  const silenceDuration = now - lastMessageTime;
  
  // 检查是否冷场
  if (silenceDuration > NOSTALGIA_CONFIG.silenceThreshold) {
    // 检查冷却时间
    if (now - lastNostalgiaTime > NOSTALGIA_CONFIG.nostalgiaCooldown) {
      const seconds = Math.floor(silenceDuration / 1000);
      log(`🎭 检测到冷场 ${seconds} 秒，尝试触发怀旧...`);
      
      const success = await triggerNostalgia(silenceDuration);
      
      if (success) {
        lastNostalgiaTime = now;
        lastMessageTime = now; // 重置冷场计时
      }
    }
  }
}

/**
 * 触发怀旧回忆
 */
async function triggerNostalgia(silenceDuration) {
  try {
    const seconds = Math.floor(silenceDuration / 1000);
    
    // 1. 触发怀旧 API
    const nostalgiaResponse = await fetch(`http://127.0.0.1:${MEMORY_PORT}/api/nostalgia/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'livestream',
        context: `冷场${seconds}秒`,
        silence_seconds: seconds
      })
    });
    
    const nostalgiaResult = await nostalgiaResponse.json();
    
    if (!nostalgiaResult.success) {
      log('ℹ️ 怀旧系统未触发（可能在冷却中或没有合适的记忆）');
      return false;
    }
    
    // 2. 通过对话获取完整的怀旧回复
    const aiReply = await getAIReply('system_nostalgia', '[NOSTALGIA_TRIGGERED]');
    
    if (aiReply) {
      log('✅ 怀旧触发成功');
      log(`💭 ${aiReply.substring(0, 50)}...`);
      
      // 使用现有的 TTS 和字幕处理
      await processTTSWithSubtitle(aiReply, `nostalgia_${Date.now()}`);
      
      return true;
    }
    
    return false;
  } catch (error) {
    log('❌ 怀旧触发失败:', error.message);
    return false;
  }
}

/**
 * 启动冷场检测
 */
function startSilenceDetection() {
  log('🎭 启动冷场检测...');
  log(`   冷场阈值: ${NOSTALGIA_CONFIG.silenceThreshold/1000}秒`);
  log(`   怀旧冷却: ${NOSTALGIA_CONFIG.nostalgiaCooldown/1000}秒`);
  
  setInterval(() => {
    checkSilenceAndNostalgia();
  }, NOSTALGIA_CONFIG.checkInterval);
}

// ============================================
// 3. 修改现有的 processMessage 函数
// ============================================

/*
在 processMessage 函数的开头添加：

function processMessage({ uname, message, type, msgId }) {
  // 更新最后消息时间（用于冷场检测）
  lastMessageTime = Date.now();
  
  // 检测续话意图
  if (detectContinueIntent(message)) {
    log('🔄 检测到续话意图');
    
    if (busy) {
      log('忙碌，忽略续话请求');
      return;
    }
    
    busy = true;
    triggerContinue(uname).finally(() => {
      busy = false;
    });
    return;
  }
  
  // ... 原有的代码 ...
}
*/

// ============================================
// 4. 在 bootstrap 函数末尾添加
// ============================================

/*
(async function bootstrap() {
  const info = await getRoomInit(ROOM_ID);
  ROOM_ID = info.roomId;
  if (info.live_status !== 1) {
    log(`房间尚未正式开播 (live_status=${info.live_status}), 将继续检查弹幕状态`);
  }
  startBridge();
  
  // 启动冷场检测
  startSilenceDetection();
})();
*/

// ============================================
// 使用说明
// ============================================

/*
完整的集成步骤：

1. 复制上面的配置和函数到 bridge.js

2. 修改 processMessage 函数，在开头添加：
   lastMessageTime = Date.now();
   if (detectContinueIntent(message)) { ... }

3. 在 bootstrap 函数末尾添加：
   startSilenceDetection();

4. 完成！现在你的弹幕桥接有了：
   ✅ 自动冷场检测和怀旧触发
   ✅ 自动续话检测
   ✅ 所有功能都自动运行
*/

export {
  detectContinueIntent,
  triggerContinue,
  checkSilenceAndNostalgia,
  triggerNostalgia,
  startSilenceDetection,
  NOSTALGIA_CONFIG,
  CONTINUE_PATTERNS
};
