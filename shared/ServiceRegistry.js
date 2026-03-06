
/**
 * ServiceRegistry - 服务注册表
 * 
 * 统一管理所有服务的配置，包括：
 * - 端口
 * - 启动命令
 * - 依赖关系
 * - 健康检查端点
 */

const path = require('path');

// 服务定义
const SERVICES = {
  // ==================== 外部依赖（不?Manager 管理）?===================
  'sovits': {
    name: 'GPT-SoVITS API',
    port: 9880,
    managed: false,  // 不由 Manager 管理
    healthEndpoint: '/set_gpt_weights',
    healthMethod: 'GET',
    description: 'GPT-SoVITS 语音合成引擎（需要手动启动）',
    startHint: '运行 memory-tts/sovits/start-api.bat'
  },

  
  // ==================== 核心服务 ====================
  'local-llm': {
    name: 'Local LLM (Qwen3-0.6B)',
    port: 4008,
    managed: true,
    priority: 0,
    healthEndpoint: '/health',
    healthMethod: 'GET',
    description: '本地语言模型 - 负责生成自然语言回复',
    dependencies: []
  },
  
  'brainnn': {
    name: 'BrainNN v7.0',
    port: 4007,
    managed: true,
    priority: 0,
    healthEndpoint: '/health',
    healthMethod: 'GET',
    description: '神经网络核心 - 情绪/人格/决策',
    dependencies: []
  },
  
  'memory-universe': {
    name: 'Memory Universe V3',
    port: 4005,
    managed: true,
    priority: 1,
    healthEndpoint: '/health',
    healthMethod: 'GET',
    description: '灵魂协调器- 记忆/信号处理/LLM调用',
    dependencies: ['brainnn', 'local-llm']
  },
  
  // ==================== 输出服务 ====================
  'tts': {
    name: 'SoVITS-TTS Adapter Service',
    port: 4014,
    managed: true,
    priority: 2,
    healthEndpoint: '/health',
    healthMethod: 'GET',
    description: '语音合成服务 (GPT-SoVITS Adapter)',
    dependencies: ['sovits']
  },
  
  'live2d': {
    name: 'Live2D Service',
    port: 4002,
    managed: true,
    priority: 3,
    healthEndpoint: '/health',
    healthMethod: 'GET',
    description: 'Live2D 虚拟形象 + 字幕',
    dependencies: []
  },
  
  // ==================== 输入服务 ====================
  'danmaku': {
    name: 'Danmaku Service',
    port: 4003,
    managed: true,
    priority: 4,
    healthEndpoint: '/api/status',
    healthMethod: 'GET',
    description: '弹幕监听 + 用户识别',
    dependencies: ['memory-universe', 'tts', 'live2d']
  },
  
  // ==================== 可选服务====================
};

/**
 * 获取所有托管服务端?
 */
function getManagedPorts() {
  return Object.values(SERVICES)
    .filter(s => s.managed)
    .map(s => s.port);
}

/**
 * 获取服务配置
 */
function getService(serviceId) {
  return SERVICES[serviceId] || null;
}

/**
 * 获取所有服?
 */
function getAllServices() {
  return { ...SERVICES };
}

/**
 * 获取服务启动顺序（按优先级和依赖关系?
 */
function getStartOrder() {
  const managed = Object.entries(SERVICES)
    .filter(([_, s]) => s.managed && !s.optional)
    .sort((a, b) => (a[1].priority || 999) - (b[1].priority || 999));
  
  return managed.map(([id, _]) => id);
}

/**
 * 获取服务停止顺序（启动顺序的逆序?
 */
function getStopOrder() {
  return getStartOrder().reverse();
}

/**
 * 检查服务依赖是否满?
 */
function checkDependencies(serviceId, runningServices) {
  const service = SERVICES[serviceId];
  
  if (!service || !service.dependencies) {
    return { satisfied: true, missing: [] };
  }
  
  const missing = service.dependencies.filter(dep => {
    const depService = SERVICES[dep];
    
    // 如果依赖是非托管服务（如 SoVITS），需要单独检?
    if (depService && !depService.managed) {
      return false;  // 非托管服务的检查由调用方处?
    }
    
    return !runningServices.includes(dep);
  });
  
  return {
    satisfied: missing.length === 0,
    missing
  };
}

/**
 * 获取服务端口映射
 */
function getPortMap() {
  const map = {};
  
  for (const [id, service] of Object.entries(SERVICES)) {
    map[id] = service.port;
  }
  
  return map;
}

module.exports = {
  SERVICES,
  getAllPorts,
  getManagedPorts,
  getService,
  getAllServices,
  getStartOrder,
  getStopOrder,
  checkDependencies,
  getPortMap
};
