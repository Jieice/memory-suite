# Memory Suite (VTuber Live Pipeline)

本项目是一个端到端 AI 虚拟主播直播系统，对标 Neuro-sama。

## 🚀 快速启动

### 方法一：一键启动（推荐）
```batch
双击 start-manager.bat
```
脚本会自动：
1. 清理残留端口
2. 启动 Manager 和所有核心服务
3. 验证服务状态

### 方法二：手动启动
1. **启动 Manager**
   ```batch
   start-manager.bat
   ```

2. **在 Manager UI 中点击"启动全部"**
   打开 http://localhost:8080

**核心服务列表（自动启动）：**
- Manager (8080) - Web 管理界面
- Memory Universe (4005) - AI 核心协调器
- BrainNN (4007) - 神经网络核心（情绪/人格）
- TTS (4014) - 语音合成服务
- Live2D (4002) - 虚拟形象 + 字幕
- Danmaku (4003) - 弹幕监听

### 停止所有服务
```batch
双击 stop-all.bat
```

## 📊 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Manager | 8080 | Web 管理界面 |
| Memory Universe | 4005 | AI 核心协调器 |
| BrainNN | 4007 | 神经网络核心（情绪/人格） |
| Agent Core | 4009 | 智能体（思考/规划） |
| Memory System V2 | 4010 | 记忆系统 |
| Reflection Engine | 4011 | 反思引擎 |
| Neuro-Symbolic Bridge | 4012 | 神经符号桥接 |
| **Prediction Engine** | **4013** | **群体智能预测引擎 🔮** |
| TTS | 4014 | 语音合成服务 |
| Live2D | 4002 | 虚拟形象 + 字幕 |
| Danmaku | 4003 | 弹幕监听 |

## 🎬 OBS 设置

在 OBS 中添加浏览器源：
- **URL**: `http://127.0.0.1:4002`
- **宽度**: 1920
- **高度**: 1080
- **勾选**: "关闭时关闭源"

## 🔧 常见问题

### 端口被占用
运行 `stop-all.bat` 或手动清理：
```batch
scripts\force-cleanup-ports.bat
```

### TTS 不工作
1. 检查 TTS 服务是否启动（端口 4014）
2. 运行 `scripts\test-full-chain.bat` 诊断

### Live2D 没有字幕/声音
1. 确保 TTS 服务正常
2. 确保 Danmaku 服务正常
3. 检查 Manager UI 中的服务日志

## 🛡️ 降级与容错系统

Memory Suite 配备了完整的**优雅降级系统**，确保当任何关键服务失败时，系统仍能继续运行：

### 核心特性

- **统一降级消息**: 当 LLM 或 TTS 失败时，返回统一消息：`"请告诉我的创造者，我的ai出现问题了"`
- **关键服务保护**: LLM 和 TTS 失败时返回降级消息，确保用户不会看到错误
- **非关键服务跳过**: BrainNN、Agent Core 等失败时，系统跳过并继续处理
- **自动重试**: 关键服务支持指数退避重试机制
- **完整日志**: 所有降级事件都被记录用于分析
- **实时监控**: 通过 Prometheus 和 Grafana 监控降级事件

### 服务分类

**关键服务**（失败返回降级消息）:
- LLM (15秒超时)
- TTS (10秒超时)

**非关键服务**（失败跳过继续）:
- BrainNN (3秒超时)
- Agent Core (2秒超时)
- Memory System V2 (2秒超时)
- Prediction Engine (2秒超时)
- Neuro-Symbolic Bridge (2秒超时)
- Reflection Engine (2秒超时)

### 监控和诊断

```bash
# 查看健康状态
curl http://localhost:8080/api/health-check

# 查看降级统计
curl http://localhost:8080/api/fallback-stats

# 查看 Prometheus 指标
curl http://localhost:8080/metrics | grep fallback

# 查看降级日志
tail -f logs/fallback-error.log
tail -f logs/fallback-warning.log
```

### 详细文档

- 📖 [降级系统完整文档](docs/FALLBACK_SYSTEM.md)
- 🔧 [故障排查指南](docs/FALLBACK_TROUBLESHOOTING.md)
- 📊 [监控设置指南](docs/FALLBACK_MONITORING.md)
- 🧠 [AI 智能与记忆系统升级指南](docs/AI_INTELLIGENCE_MEMORY_UPGRADE.md)

## 📁 项目结构

```
memory-suite/
├── manager/              # Web管理界面
├── memory-universe/      # 灵魂协调器
├── brainnn/              # 神经网络核心
│   ├── server.py         # BrainNN Core
│   ├── agent_core.py     # Agent Core
│   ├── memory_system_v2.py  # Memory System V2
│   ├── reflection_engine.py # Reflection Engine
│   ├── neuro_symbolic_bridge.py # Neuro-Symbolic Bridge
│   └── prediction_engine.py # 🔮 Prediction Engine (NEW!)
├── memory-tts/           # TTS服务
├── memory-live2d/        # Live2D显示
├── memory-danmaku/       # 弹幕监听
├── shared/               # 共享模块
├── scripts/              # 工具脚本
│   ├── prediction-example.py  # 预测引擎示例
│   └── test-prediction-engine.bat  # 预测引擎测试
├── docs/                 # 文档
│   └── prediction-engine-integration.md  # 预测引擎集成指南
├── training/             # LoRA微调管线
│   ├── prepare_data.py   # 数据提取+格式转换
│   ├── train_lora.py     # unsloth LoRA训练脚本
│   ├── export_gguf.sh    # 合并+量化+导出
│   └── data/             # 训练数据
├── data/                 # 数据文件
├── logs/                 # 日志文件
├── models/               # 模型文件
├── .env                  # 环境配置
├── package.json          # Node.js依赖
├── pm2.config.cjs        # PM2配置
├── ARCHITECTURE.md       # 架构文档（已更新）
├── PREDICTION_ENGINE_INTEGRATION.md  # 预测引擎集成完成文档
└── README.md             # 项目文档
```

## 🚀 快速开始

### 环境要求
- Node.js 18 或以上
- Python 3.10 或以上
- 已准备好 `.env`（包含LLM/TTS等密钥，勿入库）

### 安装依赖
```bash
npm install
cd memory-tts && npm install
cd memory-live2d && npm install
cd memory-danmaku && npm install
cd memory-universe && npm install
cd manager && npm install
```

### 启动服务
- Windows 一键：双击 `start-manager.bat`（会打开 http://localhost:8080），在页面里点击"启动全部"
- 或手动：在各子目录运行 `node`/`ts-node` 启动对应服务（端口见上）

### 最小自测流程
1) 启动所有服务（推荐用 `start-manager.bat`）
2) Postman/HTTP测试：
   - `POST http://localhost:8080/api/chat`，body 示例：`{ "text": "你好", "userId": "test" }`
   - `POST http://localhost:8080/api/proactive/check`，body 示例：`{ "userId": "test" }`
3) 观察：
   - Live2D 页面 `http://localhost:4002` 是否显示字幕/表情
   - TTS 是否返回 `audioPath`（如未返回，检查密钥/网络）
   - 弹幕桥接日志（配置好房间号/Cookie 后）是否正常连接

## 🔧 弹幕桥接配置
- 编辑 `memory-danmaku/config.json`：
  - `roomId`、`userUid`、`danmakuCookie`（完整B站Cookie）、`buvid`
  - `useWbiSignature`: 推荐保持 `true`（已集成 WBI 签名）
- 打开 `http://localhost:4003/danmaku-overlay.html` 以显示弹幕

## 🎬 Live2D/OBS
- OBS 浏览器源指向：`http://localhost:4003/danmaku-overlay.html`（弹幕）、`http://localhost:4002`（Live2D）
- 需保持页面常驻，否则字幕/弹幕不会显示

## 🔒 安全与防护
- 默认所有服务绑定 `127.0.0.1`；若需公网访问，请自行加网关、反向代理、令牌校验和限流
- 将真实密钥/COOKIE 仅放本地 `.env`/`config.json`，不要入库

## 📚 系统架构

### 数据流
```
弹幕 → Manager → Memory Universe → BrainNN → LLM → TTS → Live2D
```

### 核心模块
- **Manager**: Web管理界面，服务编排
- **Memory Universe**: 灵魂协调器，记忆系统
- **BrainNN**: 神经网络核心，情绪/人格/驱动力
- **TTS**: 语音合成服务
- **Live2D**: 虚拟形象显示
- **Danmaku**: 弹幕监听

## � 配置说明

### .env 配置
```bash
# 核心端口
MANAGER_PORT=8080
BRAINNN_PORT=4007
MEMORY_UNIVERSE_PORT=4005
TTS_SERVICE_PORT=4014
LIVE2D_PORT=4002
DANMAKU_SERVICE_PORT=4003

# TTS 配置
TTS_ENGINE=sovits

# Python 配置
PYTHON_EXE=python
BRAINNN_DEVICE=cpu

# 本地 LLM 配置 (node-llama-cpp)
USE_LOCAL_LLM=true
LOCAL_LLM_ENGINE=cpp
LOCAL_LLM_MODEL_PATH=models/Qwen3-4B-Instruct/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
LOCAL_LLM_GPU_LAYERS=auto
```

### 可选：Redis 弹幕/聊天缓冲（高并发）

当弹幕或聊天请求量较大时，可启用 Redis 队列缓冲，由 Manager 异步转发到 Memory Universe：

```bash
REDIS_URL=redis://127.0.0.1:6379
MANAGER_CHAT_USE_QUEUE=true
```

- 启用后，对 `POST /api/chat` 的请求会入队并立即返回 `202 Accepted`，后台消费者再转发到 Universe。
- 不配置或未设置 `MANAGER_CHAT_USE_QUEUE=true` 时，仍为同步直连转发。

## 🔍 故障排查

### 服务无法启动
1. 检查端口是否被占用：`netstat -ano | findstr :端口`
2. 检查日志文件：`logs/服务名-error.log`
3. 检查依赖是否安装：`npm list` / `pip list`

### 弹幕无法接收
1. 检查 `memory-danmaku/config.json` 配置
2. 检查 Cookie 是否有效
3. 检查直播间是否开启

### TTS 无法生成
1. 检查 TTS 服务是否运行
2. 检查模型文件是否存在
3. 检查 API 地址是否正确

### 预测引擎无响应 🆕
1. 检查服务是否运行：`curl http://localhost:4013/health`
2. 检查配置：`PREDICTION_ENABLED=true`
3. 运行测试：`python scripts/prediction-example.py`

## 🔮 新功能：Prediction Engine

Memory Suite V8 现已集成**群体智能预测引擎**！

### 核心能力
- 🎯 **互动预测**：预测观众对内容的反应
- 📊 **舆情模拟**：模拟情绪演化和风险
- 🎨 **策略优化**：推荐最优直播策略

### 快速开始
```bash
# 启动预测引擎
cd brainnn
python prediction_engine.py

# 运行示例
cd ..
python scripts/prediction-example.py
```

### 详细文档
- 📖 [预测引擎完整文档](brainnn/PREDICTION_README.md)
- 🔧 [集成指南](docs/prediction-engine-integration.md)
- 🎉 [集成完成说明](PREDICTION_ENGINE_INTEGRATION.md)

**这可能是全球首个集成预测能力的 AI VTuber 系统！** 🚀

## ✅ NN 链路完整性修复（V8.2 - 100% 通顺）

### 修复内容
已完成 NN 链路的完整修复，链路通顺度达到 **100%**：

| 流程 | 修复内容 | 状态 |
|------|---------|------|
| 正常对话 | Memory Universe → BrainNN → Agent Core → Neuro-Symbolic Bridge → Memory System V2 → LLM → Prediction Engine → TTS | ✅ |
| 主动发言 | BrainNN /tick → Agent Core /should_proactive → LLM → Prediction Engine → TTS | ✅ |
| 学习反馈 | Memory Universe → BrainNN → Reflection Engine → Soul State 更新 | ✅ |

### 关键改进
- ✅ **完整的链路**：所有关键服务都已连接
- ✅ **双向反馈**：学习反馈现在是完整的双向循环
- ✅ **规则检查**：Neuro-Symbolic Bridge 的规则检查已集成
- ✅ **思考分析**：Agent Core 的思考功能已集成
- ✅ **记忆存储**：Memory System V2 的统一接口已集成
- ✅ **风险评估**：Prediction Engine 的预测检查已集成

### 修改的文件
- `brainnn/server.py` - 增强 `/think` 端点，调用 Agent Core 和 Neuro-Symbolic Bridge
- `brainnn/neuro_symbolic_bridge.py` - 添加 `/check` 端点和 `check_all()` 方法
- `brainnn/memory_system_v2.py` - 添加 `/memory/store` 统一接口
- `brainnn/reflection_engine.py` - 增强反馈处理，生成 Soul State 更新
- `memory-universe/src/core/SoulOrchestrator.ts` - 添加所有关键服务的调用

### 完整的数据流向

**正常对话流程：**
```
用户输入 → Memory Universe /api/chat
  ↓
BrainNN /think
  ├→ Agent Core /think (思考分析) ✅
  ├→ Neuro-Symbolic Bridge /check (规则检查) ✅
  └→ Memory System V2 /memory/store (记忆存储) ✅
  ↓
LLM 生成回复
  ↓
Prediction Engine /predict/interaction (风险评估) ✅
  ↓
TTS /api/tts (语音合成)
  ↓
Live2D (虚拟形象显示)
```

**主动发言流程：**
```
定时器 (10秒) → Memory Universe
  ↓
BrainNN /tick
  ├→ Agent Core /should_proactive (主动发言决策) ✅
  └→ 驱动力更新
  ↓
LLM 生成话题
  ↓
Prediction Engine /predict/interaction (风险评估) ✅
  ↓
TTS + Live2D
```

**学习反馈流程：**
```
用户反馈 → Memory Universe /api/learning/feedback
  ↓
BrainNN /feedback
  ↓
Reflection Engine /feedback
  ├→ 处理反馈
  ├→ 生成改进建议
  └→ 生成 Soul State 更新 ✅
  ↓
BrainNN 应用 Soul State 更新 ✅
  ├→ 更新情绪
  └→ 更新驱动力
```

### 验证方式
```bash
# 运行完整的链路测试
python scripts/test-nn-chain.py
```

## 📞 技术支持

- 查看日志：`logs/` 目录
- 查看状态：http://localhost:8080
- 健康检查：http://localhost:8080/health

## 📄 许可证

本项目仅供学习和研究使用。

