# BrainNN V8 - Agentic AI 神经核心

完整的 Agentic AI 架构，包含 5 个独立服务模块。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Memory Universe                          │
│                   (协调器 - 4005)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  BrainNN (神经核心 - 4007)                   │
│  • Soul State (情绪/人格/驱动力)                             │
│  • 基础 API (/process, /think, /tick, /feedback)            │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Agent Core   │ │ Memory       │ │ Reflection   │ │ Neuro-       │
│ (4009)       │ │ System V2    │ │ Engine       │ │ Symbolic     │
│              │ │ (4010)       │ │ (4011)       │ │ Bridge       │
│ • 思考       │ │              │ │              │ │ (4012)       │
│ • 规划       │ │ • 短期记忆   │ │ • 自我评估   │ │              │
│ • 决策       │ │ • 长期记忆   │ │ • 错误分析   │ │ • 规则引擎   │
│ • 主动发言   │ │ • 情景记忆   │ │ • 在线学习   │ │ • 逻辑推理   │
│              │ │ • 语义记忆   │ │ • 性能优化   │ │ • 神经融合   │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## 服务说明

### 1. BrainNN (server.py) - 端口 4007
**神经网络核心**

- **功能**：
  - Soul State 管理（8维情绪、Big Five 人格、4维驱动力）
  - 情绪衰减和基线回归
  - 生成情绪指令（传给 LLM）
  - 协调其他 4 个模块

- **API**：
  - `POST /process` - 处理输入
  - `POST /think` - 思考接口
  - `GET /tick` - 心跳检查（主动发言）
  - `POST /feedback` - 学习反馈
  - `GET /state` - 获取状态
  - `POST /reset` - 重置状态

### 2. Agent Core (agent_core.py) - 端口 4009
**智能体核心**

- **功能**：
  - 情况分析（基于 Soul State）
  - 目标设定和行动规划
  - 主动发言决策
  - 推理链生成

- **API**：
  - `POST /think` - 执行思考
  - `POST /should_proactive` - 检查是否主动发言
  - `POST /plan` - 创建行动计划
  - `GET /state` - 获取状态

- **决策逻辑**：
  - 无聊度 > 0.75 → 主动发言
  - 社交需求 > 0.7 且 3分钟无互动 → 主动发言
  - 超过 5分钟无互动 → 强制主动发言

### 3. Memory System V2 (memory_system_v2.py) - 端口 4010
**记忆系统**

- **功能**：
  - 短期记忆（工作记忆，容量 20）
  - 长期记忆（重要信息永久存储）
  - 情景记忆（对话历史）
  - 语义记忆（知识概念）
  - 记忆巩固（短期 → 长期）

- **API**：
  - `POST /add/short_term` - 添加短期记忆
  - `POST /add/episodic` - 添加情景记忆
  - `POST /add/semantic` - 添加语义记忆
  - `GET /recall/short_term` - 回忆短期记忆
  - `GET /recall/episodic` - 回忆情景记忆
  - `GET /search/semantic` - 搜索语义记忆
  - `GET /stats` - 获取统计

- **数据库**：`data/memory_v2.db` (SQLite)

### 4. Reflection Engine (reflection_engine.py) - 端口 4011
**反思引擎**

- **功能**：
  - 反馈处理（正面/负面/中性）
  - 错误分析和记录
  - 自我反思（每 5 次反馈）
  - 性能指标追踪
  - 学习记录

- **API**：
  - `POST /feedback` - 处理反馈
  - `POST /reflect` - 手动触发反思
  - `POST /error` - 记录错误
  - `POST /metric` - 记录性能指标
  - `GET /performance` - 获取性能摘要
  - `GET /learning` - 获取学习历史

- **数据库**：`data/reflection.db` (SQLite)

### 5. Neuro-Symbolic Bridge (neuro_symbolic_bridge.py) - 端口 4012
**神经符号桥接**

- **功能**：
  - 神经网络 + 符号推理融合
  - 规则引擎（敏感词过滤、重复检测等）
  - 逻辑推理
  - 知识库管理

- **API**：
  - `POST /process` - 神经符号融合
  - `GET /rules` - 获取规则列表
  - `POST /knowledge/add` - 添加知识
  - `GET /knowledge/query` - 查询知识
  - `POST /infer` - 执行推理
  - `GET /explain` - 解释推理过程

- **内置规则**：
  - 敏感词过滤（优先级 10）
  - 重复消息检测（优先级 9）
  - 情绪调节（优先级 7）
  - 问候语检测（优先级 5）
  - 提问检测（优先级 6）

## 工作流程

### 1. 正常对话流程
```
用户输入 → Memory Universe → BrainNN (/think)
                                  ↓
                          Agent Core (/think)
                                  ↓
                          Memory System (/add/episodic)
                                  ↓
                          Neuro-Symbolic Bridge (/process)
                                  ↓
                          生成回复 → LLM → TTS → Live2D
```

### 2. 主动发言流程
```
定时器 → Memory Universe → BrainNN (/tick)
                              ↓
                      Agent Core (/should_proactive)
                              ↓
                      判断：是否主动发言？
                              ↓
                      生成话题 → LLM → TTS → Live2D
```

### 3. 学习反馈流程
```
用户反馈 → Memory Universe → BrainNN (/feedback)
                                  ↓
                          Reflection Engine (/feedback)
                                  ↓
                          累积 5 次 → 自动反思
                                  ↓
                          生成改进建议 → 记录学习
```

## 启动方式

### 方式 1：使用启动脚本（推荐）
```bash
cd memory-suite
start-manager.bat
```

这会自动启动所有 5 个服务 + Manager。

### 方式 2：单独启动
```bash
# 1. BrainNN
cd brainnn
python server.py

# 2. Agent Core
python agent_core.py

# 3. Memory System V2
python memory_system_v2.py

# 4. Reflection Engine
python reflection_engine.py

# 5. Neuro-Symbolic Bridge
python neuro_symbolic_bridge.py
```

## 环境变量

在 `.env` 文件中配置：

```env
# 端口配置
BRAINNN_PORT=4007
AGENT_CORE_PORT=4009
MEMORY_SYSTEM_V2_PORT=4010
REFLECTION_ENGINE_PORT=4011
NEURO_SYMBOLIC_BRIDGE_PORT=4012

# 服务 URL（可选，默认使用 localhost）
AGENT_CORE_URL=http://127.0.0.1:4009
MEMORY_SYSTEM_V2_URL=http://127.0.0.1:4010
REFLECTION_ENGINE_URL=http://127.0.0.1:4011
NEURO_SYMBOLIC_BRIDGE_URL=http://127.0.0.1:4012
```

## 依赖安装

```bash
cd brainnn
pip install -r requirements.txt
```

requirements.txt 内容：
```
flask>=2.0.0
flask-cors>=3.0.0
requests>=2.25.0
```

## 测试 API

### 测试 BrainNN
```bash
curl -X POST http://localhost:4007/think -H "Content-Type: application/json" -d "{\"text\":\"你好\"}"
```

### 测试 Agent Core
```bash
curl -X POST http://localhost:4009/should_proactive -H "Content-Type: application/json" -d "{\"soul_state\":{\"drives\":{\"boredom\":0.8}},\"time_since_last\":200}"
```

### 测试 Memory System
```bash
curl -X POST http://localhost:4010/add/short_term -H "Content-Type: application/json" -d "{\"content\":\"测试记忆\",\"importance\":0.8}"
```

### 测试 Reflection Engine
```bash
curl -X POST http://localhost:4011/feedback -H "Content-Type: application/json" -d "{\"type\":\"positive\",\"value\":0.9}"
```

### 测试 Neuro-Symbolic Bridge
```bash
curl -X POST http://localhost:4012/process -H "Content-Type: application/json" -d "{\"neural_output\":{},\"context\":{\"text\":\"你好\"}}"
```

## 监控和调试

### 查看日志
```bash
# 所有日志在 logs 目录
tail -f logs/brainnn.log
tail -f logs/agent_core.log
tail -f logs/memory_system_v2.log
tail -f logs/reflection_engine.log
tail -f logs/neuro_symbolic_bridge.log
```

### Web 管理界面
访问 http://localhost:8080 查看所有服务状态、日志和控制。

## 性能优化

- **BrainNN**：情绪衰减率可调（默认 0.02）
- **Agent Core**：主动发言冷却时间可调（默认 180秒）
- **Memory System**：短期记忆容量可调（默认 20）
- **Reflection Engine**：反思阈值可调（默认 5 次反馈）
- **Neuro-Symbolic**：规则优先级可调

## 扩展开发

### 添加自定义规则
编辑 `neuro_symbolic_bridge.py`，在 `_init_default_rules()` 中添加：

```python
def check_custom(ctx):
    # 你的条件
    return True

def action_custom(ctx):
    # 你的动作
    return {'action': 'custom'}

self.add_rule('custom_rule', check_custom, action_custom, priority=8)
```

### 添加新的记忆类型
编辑 `memory_system_v2.py`，在 `init_db()` 中添加新表。

### 添加新的性能指标
使用 Reflection Engine 的 `/metric` API：

```python
requests.post('http://localhost:4011/metric', json={
    'name': 'response_time',
    'value': 0.5
})
```

## 故障排查

### 服务无法启动
1. 检查端口是否被占用：`netstat -ano | findstr :4007`
2. 检查 Python 版本：`python --version` (需要 3.7+)
3. 检查依赖：`pip list | grep flask`

### 服务间通信失败
1. 检查防火墙设置
2. 确认所有服务都已启动
3. 查看日志中的错误信息

### 数据库错误
1. 检查 `data` 目录权限
2. 删除旧数据库重新初始化：`rm data/*.db`

## 版本历史

- **V8.0** (2026-01) - 完整 Agentic AI 架构
  - 新增 Agent Core（思考/规划）
  - 新增 Memory System V2（多类型记忆）
  - 新增 Reflection Engine（在线学习）
  - 新增 Neuro-Symbolic Bridge（符号融合）

- **V7.0** - 基础 Soul State 系统
  - 情绪/人格/驱动力管理

## 许可证

MIT License
