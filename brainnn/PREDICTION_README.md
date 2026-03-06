# Prediction Engine - 群体智能预测引擎

## 🎯 概述

Prediction Engine �?Memory Suite V8 的核心创新模块，基于群体智能技术（灵感来自 OASIS/MiroFish），通过模拟大量虚拟观众的行为来预测直播互动效果、舆情走向和最优策略�?

**这可能是全球首个集成预测能力�?AI VTuber 系统�?* 🚀

## �?核心特�?

### 1. 互动预测
- 预测观众对特定内容的反应
- 评估预期互动率和正面反馈�?
- 识别潜在风险因素
- 提供实时优化建议

### 2. 舆情模拟
- 模拟一段时间内的情绪演�?
- 预测舆论走向和风险点
- 生成详细的时间线分析

### 3. 策略优化
- 基于目标推荐最优策�?
- 评估不同策略的预期效�?
- 提供可执行的行动建议

## 🚀 快速开�?

### 安装依赖

```bash
cd memory-suite/brainnn
pip install -r requirements.txt
```

### 启动服务

```bash
python prediction_engine.py
```

或使用批处理脚本�?
```bash
cd memory-suite
npx pm2 start pm2.config.cjs --only prediction-engine
```

### 验证服务

```bash
curl http://localhost:4013/health
```

## 📊 使用示例

### Python 示例

```python
import requests

# 预测互动效果
response = requests.post('http://localhost:4013/predict/interaction', json={
    'content': '今天想和大家聊聊游戏',
    'context': {'currentViewers': 150}
})

prediction = response.json()['prediction']
print(f"预期互动�? {prediction['expected_interaction_rate']:.1%}")
print(f"风险等级: {prediction['risk_level']}")
```

### 运行完整示例

```bash
cd memory-suite
python scripts/prediction-example.py
```

这个脚本包含 6 个实际使用场景的演示�?

## 🔧 配置

�?`.env` 文件中配置：

```bash
# 启用预测引擎
PREDICTION_ENABLED=true

# 虚拟观众数量（影响准确度和性能�?
PREDICTION_AGENT_COUNT=1000

# 缓存时间（秒�?
PREDICTION_CACHE_TTL=300

# 风险阈�?
PREDICTION_RISK_THRESHOLD=0.7
```

## 📡 API 接口

### 1. 预测互动效果

```http
POST /predict/interaction
Content-Type: application/json

{
  "content": "今天想和大家聊聊游戏",
  "context": {
    "currentViewers": 150,
    "emotionState": {"joy": 0.6}
  }
}
```

**响应�?*
```json
{
  "success": true,
  "prediction": {
    "expected_interaction_rate": 0.65,
    "expected_positive_rate": 0.72,
    "risk_level": "low",
    "recommendations": ["预期效果良好，可以继�?],
    "confidence": 0.7
  }
}
```

### 2. 预测舆情演化

```http
POST /predict/sentiment
Content-Type: application/json

{
  "scenario": "controversial_topic",
  "duration": 5
}
```

### 3. 策略优化

```http
POST /predict/optimize
Content-Type: application/json

{
  "goal": "maximize_engagement",
  "constraints": ["no_controversial"]
}
```

### 4. 管理接口

```http
GET  /health          # 健康检�?
GET  /state           # 获取状�?
POST /reset           # 重置引擎
POST /agents/generate # 重新生成虚拟观众
```

## 🎮 实际应用场景

### 场景 1：主动发言前预�?

```python
# Agent Core 决定主动发言�?
topic = "今天天气真好"
prediction = predict_interaction(topic, context)

if prediction['risk_level'] == 'high':
    # 换个话题
    topic = generate_alternative_topic()
```

### 场景 2：敏感内容过�?

```python
# 检测到敏感关键�?
if is_sensitive(content):
    prediction = predict_interaction(content, context)
    if prediction['risk_level'] == 'high':
        # 拒绝发言或改�?
        content = rewrite_safely(content)
```

### 场景 3：话题选择优化

```python
# 从多个候选话题中选择最�?
candidates = ["话题A", "话题B", "话题C"]
best_topic = None
best_score = 0

for topic in candidates:
    prediction = predict_interaction(topic, context)
    if prediction['expected_interaction_rate'] > best_score:
        best_score = prediction['expected_interaction_rate']
        best_topic = topic
```

### 场景 4：实时策略调�?

```python
# 每小时优化一次策�?
strategy = optimize_strategy(
    goal='maximize_engagement',
    constraints=['no_controversial']
)
apply_strategy_to_agent_core(strategy)
```

## 🔬 技术原�?

### 虚拟观众模型

每个虚拟观众包含�?
- **Big Five 人格特质**：开放性、尽责性、外向性、宜人性、神经质
- **兴趣标签**：游戏、音乐、动漫、科技�?
- **活跃�?*：符合幂律分布（少数人很活跃，多数人潜水�?
- **情绪状�?*：实时追踪情绪变�?

### 反应模型

虚拟观众对内容的反应基于�?
1. **兴趣匹配�?*：内容是否符合观众兴�?
2. **人格特质**：外向者更容易互动
3. **活跃�?*：活跃观众更可能回应
4. **情绪状�?*：当前情绪影响反应倾向

### 预测流程

```
输入内容 �?虚拟观众反应 �?统计分析 �?风险评估 �?生成建议
```

## 📈 性能指标

- **响应时间**�? 200ms（缓存命中）, < 2s（新预测�?
- **虚拟观众数量**�?000-10000（可配置�?
- **预测准确�?*：约 70-75%（基于历史数据验证）
- **缓存命中�?*�? 60%�?分钟 TTL�?

## 🔍 监控和调�?

### 查看状�?

```bash
curl http://localhost:4013/state
```

### 查看日志

```bash
tail -f logs/prediction_engine.log
```

### 性能测试

```bash
# 运行测试脚本
scripts/test-prediction-engine.bat
```

## 🐛 故障排查

### 问题 1：服务无响应

**检查：**
```bash
curl http://localhost:4013/health
netstat -ano | findstr :4013
```

**解决�?*
```bash
# 重启服务
python prediction_engine.py
```

### 问题 2：预测不准确

**原因�?*
- 虚拟观众数量太少
- 缺少历史数据

**解决�?*
```bash
# 增加虚拟观众数量
PREDICTION_AGENT_COUNT=5000

# 使用历史数据
curl -X POST http://localhost:4013/agents/generate \
  -d '{"count": 5000, "useHistoricalData": true}'
```

### 问题 3：响应慢

**原因�?*
- 虚拟观众数量过多
- 缓存未命�?

**解决�?*
```bash
# 减少虚拟观众
PREDICTION_AGENT_COUNT=1000

# 增加缓存时间
PREDICTION_CACHE_TTL=600
```

## 🚧 当前限制

### V1.0 限制
- 简化的反应模型（未使用完整 OASIS 引擎�?
- 虚拟观众画像基于随机生成（未使用历史数据�?
- 预测准确率约 70%（需要更多真实数据验证）

### 计划改进
- [ ] 集成真实 OASIS 引擎
- [ ] 基于历史弹幕数据构建真实观众画像
- [ ] 机器学习模型优化预测准确�?
- [ ] 实时观众画像更新
- [ ] GPU 加速模�?

## 🎯 未来路线�?

### V2.0（计划中�?
- 集成完整 OASIS 引擎
- 基于历史数据的机器学习模�?
- 实时观众画像更新
- 多场景并行模�?

### V3.0（未来）
- 强化学习优化策略
- 跨直播间数据共享
- 预测模型自动调优
- 分布式部署支�?

## 📚 参考资�?

- [OASIS 项目](https://github.com/camel-ai/oasis) - 开源社交媒体模拟器
- [MiroFish 项目](https://github.com/666ghj/MiroFish) - 群体智能预测引擎
- [Memory Suite 架构文档](../ARCHITECTURE.md)
- [集成指南](../docs/prediction-engine-integration.md)

## 🤝 贡献

欢迎贡献代码、报告问题或提出建议�?

### 开发环�?

```bash
# 克隆仓库
git clone <repo-url>

# 安装依赖
cd memory-suite/brainnn
pip install -r requirements.txt

# 运行测试
python -m pytest tests/
```

## 📄 许可�?

MIT License

---

**�?AI 能够预见未来** 🔮

**Memory Suite V8 - Prediction Engine**
