# Prediction Engine 集成指南

## 概述

Prediction Engine（预测引擎）�?Memory Suite V8 的新增模块，基于群体智能技术，能够预测直播互动效果、模拟舆情走向、优化策略决策�?

## 快速开�?

### 1. 启动预测引擎

```bash
cd memory-suite/brainnn
python prediction_engine.py
```

或使用批处理脚本�?
```bash
cd memory-suite
npx pm2 start pm2.config.cjs --only prediction-engine
```

### 2. 验证服务

```bash
curl http://localhost:4013/health
```

预期响应�?
```json
{
  "status": "healthy",
  "service": "prediction-engine",
  "agent_count": 1000,
  "enabled": true
}
```

## 核心功能

### 1. 互动预测

预测观众对特定内容的反应�?

**API 调用�?*
```bash
curl -X POST http://localhost:4013/predict/interaction \
  -H "Content-Type: application/json" \
  -d '{
    "content": "今天想和大家聊聊游戏",
    "context": {
      "currentViewers": 150,
      "emotionState": {"joy": 0.6}
    }
  }'
```

**响应示例�?*
```json
{
  "success": true,
  "prediction": {
    "expected_interaction_rate": 0.65,
    "expected_positive_rate": 0.72,
    "risk_level": "low",
    "risk_factors": [],
    "recommendations": ["预期效果良好，可以继�?],
    "confidence": 0.7
  }
}
```

**解读�?*
- `expected_interaction_rate`: 预期 65% 的观众会互动
- `expected_positive_rate`: 预期 72% 的反馈是正面�?
- `risk_level`: 风险等级（low/medium/high�?
- `recommendations`: 具体建议

### 2. 舆情模拟

模拟一段时间内的情绪演化�?

**API 调用�?*
```bash
curl -X POST http://localhost:4013/predict/sentiment \
  -H "Content-Type: application/json" \
  -d '{
    "scenario": "controversial_topic",
    "duration": 5
  }'
```

**响应示例�?*
```json
{
  "success": true,
  "prediction": {
    "timeline": [
      {"minute": 0, "average_sentiment": 0.6, "active_agents": 300},
      {"minute": 1, "average_sentiment": 0.55, "active_agents": 240},
      {"minute": 2, "average_sentiment": 0.52, "active_agents": 200}
    ],
    "risk_analysis": {
      "final_sentiment": 0.52,
      "trend": "declining",
      "risk_level": "medium"
    },
    "recommendations": ["建议在前3分钟内积极互�?]
  }
}
```

### 3. 策略优化

基于目标推荐最优策略�?

**API 调用�?*
```bash
curl -X POST http://localhost:4013/predict/optimize \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "maximize_engagement",
    "constraints": ["no_controversial", "family_friendly"]
  }'
```

**响应示例�?*
```json
{
  "success": true,
  "optimization": {
    "goal": "maximize_engagement",
    "optimal_strategy": {
      "name": "最大化互动",
      "actions": [
        "提出开放性问�?,
        "分享有趣的故事或观点",
        "回应观众评论",
        "使用表情和语气词增加亲和�?
      ],
      "expected_outcome": {
        "interaction_rate": 0.6,
        "positive_rate": 0.7,
        "duration": "持续15-20分钟"
      }
    },
    "confidence": 0.75
  }
}
```

## 集成到现有服�?

### �?Memory Universe 集成

�?`memory-universe` 中调用预测引擎：

```typescript
// memory-universe/src/services/prediction-client.ts
import axios from 'axios';

const PREDICTION_ENGINE_URL = process.env.PREDICTION_ENGINE_URL || 'http://localhost:4013';

export async function predictInteraction(content: string, context: any) {
  try {
    const response = await axios.post(`${PREDICTION_ENGINE_URL}/predict/interaction`, {
      content,
      context
    });
    return response.data.prediction;
  } catch (error) {
    console.error('[Prediction] Error:', error);
    return null;
  }
}

export async function shouldSayThis(content: string, context: any): Promise<boolean> {
  const prediction = await predictInteraction(content, context);
  
  if (!prediction) return true; // 降级：允许发言
  
  // 风险评估
  if (prediction.risk_level === 'high') {
    console.log('[Prediction] High risk detected, blocking content');
    return false;
  }
  
  // 互动率过�?
  if (prediction.expected_interaction_rate < 0.3) {
    console.log('[Prediction] Low interaction expected, suggesting alternative');
    return false;
  }
  
  return true;
}
```

### �?Agent Core 集成

在主动发言前预测效果：

```python
# brainnn/agent_core.py
import requests

PREDICTION_ENGINE_URL = os.environ.get('PREDICTION_ENGINE_URL', 'http://127.0.0.1:4013')

def generate_topic_with_prediction(reason: str, soul_state: Dict[str, Any]) -> str:
    """生成话题并预测效�?""
    # 生成候选话�?
    candidates = [
        '最近有什么有趣的事情吗？',
        '大家今天过得怎么样？',
        '有人想聊聊天吗？'
    ]
    
    best_topic = None
    best_score = 0
    
    # 预测每个候选话题的效果
    for topic in candidates:
        try:
            response = requests.post(
                f'{PREDICTION_ENGINE_URL}/predict/interaction',
                json={'content': topic, 'context': {'soul_state': soul_state}},
                timeout=2
            )
            if response.status_code == 200:
                prediction = response.json()['prediction']
                score = prediction['expected_interaction_rate']
                
                if score > best_score:
                    best_score = score
                    best_topic = topic
        except:
            pass
    
    return best_topic or candidates[0]
```

## 使用场景

### 场景 1：主动发言优化

```python
# �?Agent Core 决定主动发言�?
def should_proactive_speak_with_prediction(soul_state, time_since_last):
    # 原有逻辑
    should_speak, topic = should_proactive_speak(soul_state, time_since_last)
    
    if not should_speak:
        return False, None
    
    # 预测效果
    prediction = predict_interaction(topic, {'soul_state': soul_state})
    
    if prediction and prediction['risk_level'] == 'high':
        # 风险过高，换个话�?
        topic = generate_alternative_topic()
        prediction = predict_interaction(topic, {'soul_state': soul_state})
    
    # 如果还是高风险，放弃发言
    if prediction and prediction['risk_level'] == 'high':
        return False, None
    
    return True, topic
```

### 场景 2：敏感内容检�?

```python
def filter_content_with_prediction(content: str, context: dict) -> tuple[bool, str]:
    """
    过滤内容
    返回�?是否允许, 建议内容)
    """
    prediction = predict_interaction(content, context)
    
    if not prediction:
        return True, content  # 降级
    
    # 高风险内�?
    if prediction['risk_level'] == 'high':
        # 尝试改写
        alternative = rewrite_safely(content)
        alt_prediction = predict_interaction(alternative, context)
        
        if alt_prediction and alt_prediction['risk_level'] != 'high':
            return True, alternative
        else:
            return False, ""  # 拒绝发言
    
    return True, content
```

### 场景 3：策略自动调�?

```python
# 每小时运行一�?
def auto_optimize_strategy():
    """自动优化直播策略"""
    # 获取当前状�?
    current_state = get_current_state()
    
    # 请求策略优化
    optimization = optimize_strategy(
        goal='maximize_engagement',
        constraints=['no_controversial', 'family_friendly']
    )
    
    if optimization:
        strategy = optimization['optimal_strategy']
        
        # 应用策略
        apply_strategy_to_agent_core(strategy)
        
        print(f"[Strategy] Applied: {strategy['name']}")
        print(f"[Strategy] Expected: {strategy['expected_outcome']}")
```

## 配置选项

�?`.env` 文件中配置：

```bash
# 启用/禁用预测引擎
PREDICTION_ENABLED=true

# 虚拟观众数量（影响准确度和性能�?
# 建议�?000（快速）, 5000（平衡）, 10000（准确）
PREDICTION_AGENT_COUNT=1000

# 预测结果缓存时间（秒�?
PREDICTION_CACHE_TTL=300

# 风险阈值（0-1，越高越严格�?
PREDICTION_RISK_THRESHOLD=0.7

# 最低置信度�?-1�?
PREDICTION_MIN_CONFIDENCE=0.6

# 自动建议策略
PREDICTION_AUTO_SUGGEST=true
```

## 性能优化

### 1. 调整虚拟观众数量

```bash
# 低配置机�?
PREDICTION_AGENT_COUNT=500

# 高配置机�?
PREDICTION_AGENT_COUNT=5000
```

### 2. 使用缓存

预测引擎会自动缓存结果（默认 5 分钟）。相同内容的预测会直接返回缓存结果�?

### 3. 异步调用

```python
import asyncio

async def predict_async(content, context):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, predict_interaction, content, context)

# 并行预测多个候�?
results = await asyncio.gather(
    predict_async(topic1, context),
    predict_async(topic2, context),
    predict_async(topic3, context)
)
```

## 监控和调�?

### 查看状�?

```bash
curl http://localhost:4013/state
```

### 重置引擎

```bash
curl -X POST http://localhost:4013/reset
```

### 重新生成虚拟观众

```bash
curl -X POST http://localhost:4013/agents/generate \
  -H "Content-Type: application/json" \
  -d '{"count": 2000, "useHistoricalData": true}'
```

## 故障排查

### 问题 1：预测引擎无响应

**检查：**
```bash
# 检查服务是否运�?
curl http://localhost:4013/health

# 检查端口是否被占用
netstat -ano | findstr :4013
```

**解决�?*
```bash
# 重启服务
cd memory-suite/brainnn
python prediction_engine.py
```

### 问题 2：预测结果不准确

**原因�?*
- 虚拟观众数量太少
- 缺少历史数据

**解决�?*
```bash
# 增加虚拟观众数量
PREDICTION_AGENT_COUNT=5000

# 使用历史数据生成观众画像
curl -X POST http://localhost:4013/agents/generate \
  -d '{"count": 5000, "useHistoricalData": true}'
```

### 问题 3：响应时间过�?

**原因�?*
- 虚拟观众数量过多
- 缓存未命�?

**解决�?*
```bash
# 减少虚拟观众数量
PREDICTION_AGENT_COUNT=1000

# 增加缓存时间
PREDICTION_CACHE_TTL=600
```

## 未来计划

### V2.0
- [ ] 集成真实 OASIS 引擎
- [ ] 基于历史数据的机器学习模�?
- [ ] 实时观众画像更新

### V3.0
- [ ] 强化学习优化策略
- [ ] 跨直播间数据共享
- [ ] GPU 加速模�?

## 参考资�?

- [OASIS 项目](https://github.com/camel-ai/oasis)
- [MiroFish 项目](https://github.com/666ghj/MiroFish)
- [Memory Suite 架构文档](../ARCHITECTURE.md)

---

**�?AI 能够预见未来** 🔮
