# 后台控制API使用指南

本文档介绍如何使用后台控制API来控制AI虚拟主播的话题、行为模式和情绪状态。

## 快速开始

所有控制API都通过Manager代理，基础URL为：`http://localhost:8080/api/control/`

## API端点

### 1. 话题控制

#### 启动新话题
```bash
POST /api/control/topic/start
Content-Type: application/json

{
  "topic": "游戏攻略",
  "context": "今天我们来聊聊最新的游戏攻略",
  "priority": "high"  // 可选: "high" | "normal" | "low"
}
```

#### 切换话题
```bash
POST /api/control/topic/switch
Content-Type: application/json

{
  "fromTopic": "游戏攻略",  // 可选，不指定则切换当前话题
  "toTopic": "美食分享",
  "transition": "smooth",  // 可选: "smooth" | "abrupt"
  "context": "让我们换个轻松的话题"
}
```

#### 结束话题
```bash
POST /api/control/topic/end
Content-Type: application/json

{
  "topic": "游戏攻略",
  "reason": "时间到了"  // 可选
}
```

### 2. 行为控制

#### 设置行为模式
```bash
POST /api/control/behavior/set
Content-Type: application/json

{
  "behavior": "proactive",  // "proactive" | "reactive" | "silent"
  "duration": 3600,  // 可选，秒数，0表示永久
  "reason": "需要活跃气氛"  // 可选
}
```

**行为模式说明**：
- `proactive`: 主动发言模式，AI会更频繁地主动开启话题
- `reactive`: 反应模式（默认），AI主要回应观众
- `silent`: 静默模式，AI不会主动发言，只回应

### 3. 情绪控制

#### 设置情绪状态
```bash
POST /api/control/mood/set
Content-Type: application/json

{
  "mood": "excited",  // "happy" | "excited" | "calm" | "curious" | "playful" | "serious" | "energetic" | "relaxed"
  "intensity": 0.8,  // 可选，0-1，默认0.7
  "duration": 1800  // 可选，秒数，0表示永久
}
```

### 4. 实时指令

#### 执行控制指令
```bash
POST /api/control/command
Content-Type: application/json

{
  "command": "say_hello",  // 见下方指令列表
  "params": {  // 可选
    "target": "观众朋友们"
  }
}
```

**可用指令**：
- `say_hello`: 打招呼
- `tell_joke`: 讲笑话
- `ask_question`: 提问
- `share_story`: 分享故事
- `react_to_danmaku`: 回应弹幕
- `check_audience`: 检查观众
- `promote_topic`: 推广话题

### 5. 获取控制状态

#### 查看当前控制状态
```bash
GET /api/control/state
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "currentTopic": {
      "topic": "游戏攻略",
      "context": "今天我们来聊聊最新的游戏攻略",
      "priority": "high",
      "startedAt": 1707123456789
    },
    "topicStack": [
      // 最近5个话题历史
    ],
    "behavior": {
      "mode": "proactive",
      "startedAt": 1707123456789,
      "expiresAt": null
    },
    "mood": {
      "mood": "excited",
      "intensity": 0.8,
      "startedAt": 1707123456789,
      "expiresAt": null
    },
    "pendingCommands": 0
  }
}
```

## 使用示例

### 示例1：开启新话题并设置主动模式

```bash
# 1. 启动话题
curl -X POST http://localhost:8080/api/control/topic/start \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "AI技术讨论",
    "context": "让我们聊聊最新的AI技术",
    "priority": "high"
  }'

# 2. 设置为主动模式
curl -X POST http://localhost:8080/api/control/behavior/set \
  -H "Content-Type: application/json" \
  -d '{
    "behavior": "proactive",
    "duration": 3600,
    "reason": "新话题需要活跃气氛"
  }'

# 3. 设置兴奋情绪
curl -X POST http://localhost:8080/api/control/mood/set \
  -H "Content-Type: application/json" \
  -d '{
    "mood": "excited",
    "intensity": 0.9,
    "duration": 1800
  }'
```

### 示例2：切换话题

```bash
# 从"游戏攻略"切换到"美食分享"
curl -X POST http://localhost:8080/api/control/topic/switch \
  -H "Content-Type: application/json" \
  -d '{
    "fromTopic": "游戏攻略",
    "toTopic": "美食分享",
    "transition": "smooth",
    "context": "让我们换个轻松的话题"
  }'
```

### 示例3：执行实时指令

```bash
# 让AI讲个笑话
curl -X POST http://localhost:8080/api/control/command \
  -H "Content-Type: application/json" \
  -d '{
    "command": "tell_joke"
  }'

# 让AI打招呼
curl -X POST http://localhost:8080/api/control/command \
  -H "Content-Type: application/json" \
  -d '{
    "command": "say_hello",
    "params": {
      "target": "观众朋友们"
    }
  }'
```

### 示例4：查看当前状态

```bash
curl http://localhost:8080/api/control/state
```

## 注意事项

1. **优先级**：控制指令的优先级高于自然对话，AI会优先执行控制指令
2. **话题栈**：系统会保存最近的话题历史，可以通过状态API查看
3. **过期时间**：行为模式和情绪可以设置持续时间，到期后自动恢复默认状态
4. **并发安全**：控制管理器是单例，支持并发请求
5. **错误处理**：所有API都会返回标准的`{success: boolean, error?: string}`格式

## 集成到现有系统

控制管理器已经集成到Memory Universe，可以通过以下方式在代码中使用：

```typescript
import { getControlManager } from './core/ControlManager';

const controlManager = getControlManager();

// 启动话题
controlManager.startTopic('新话题', '上下文', 'high');

// 设置行为
controlManager.setBehavior('proactive', 3600, '需要活跃气氛');

// 执行指令
const result = await controlManager.executeCommand('say_hello', { target: '大家' });
```

## 故障排查

1. **API无响应**：检查Manager和Memory Universe服务是否正常运行
2. **控制不生效**：检查是否有其他控制指令覆盖了当前设置
3. **话题切换失败**：确认当前话题名称是否正确（可通过状态API查看）
