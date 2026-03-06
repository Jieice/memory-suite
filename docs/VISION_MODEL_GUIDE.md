# 视觉模型配置指南

Memory Suite v2 的视觉功能需要本地视觉模型支持。以下是完整的配置指南。

## 1. 功能说明

**当前状态**: Vision Service 已实现框架，但需要视觉模型才能真正工作。

**没有模型时的行为**:
- `captureScreen()` - 可以截屏（不需要模型）
- `analyzeImage()` - 返回 mock 数据（需要模型才能分析）
- `needsVisionContext()` - 可以检测关键词（不需要模型）

## 2. 推荐模型

### 方案 A: Qwen2-VL-2B (推荐)

**优点**: 性能好，支持中文，GPU 加速
**硬件需求**: ~1.5GB VRAM (Q4_K_M 量化)

```bash
# 下载模型 (选择一个)
# HuggingFace
huggingface-cli download Qwen/Qwen2-VL-2B-Instruct-GGUF qwen2-vl-2b-instruct-q4_k_m.gguf --local-dir ./models

# 或 ModelScope (国内更快)
modelscope download --model Qwen/Qwen2-VL-2B-Instruct-GGUF qwen2-vl-2b-instruct-q4_k_m.gguf --local_dir ./models
```

### 方案 B: Moondream 2B

**优点**: 轻量，CPU 可运行
**硬件需求**: ~2GB RAM

```bash
# 下载 GGUF 版本
huggingface-cli download vikhyatk/moondream2-gguf moondream2-q4_k_m.gguf --local-dir ./models
```

### 方案 C: 云端 API (不推荐)

**优点**: 无需本地模型
**缺点**: 延迟高，需要网络

## 3. 配置步骤

### Step 1: 下载模型

```bash
cd d:\AI\memory-suite

# 创建模型目录
mkdir models

# 下载 Qwen2-VL-2B (推荐)
# 从 https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct-GGUF 下载
# 或使用镜像站
```

### Step 2: 配置环境变量

在 `.env` 文件中添加:

```bash
# 视觉服务配置
VISION_ENABLED=true
VISION_MODEL_PATH=../models/qwen2-vl-2b-instruct-q4_k_m.gguf
VISION_CAPTURE_INTERVAL=5000
VISION_MAX_IMAGE_SIZE=1920
```

### Step 3: 安装依赖

```bash
cd memory-universe
npm install
```

### Step 4: 测试

```bash
# 启动服务
npm run dev

# 测试 API
curl http://localhost:4005/api/vision/status
curl -X POST http://localhost:4005/api/vision/capture
```

## 4. 当前可用的功能 (无需模型)

即使没有视觉模型，以下功能仍然可用:

### 4.1 关键词检测

```typescript
// 检测用户消息是否需要视觉上下文
const vision = getVisionService();
if (vision.needsVisionContext('你看到画面里有什么？')) {
    // 需要视觉上下文
}
```

### 4.2 屏幕捕获

```typescript
// 可以截屏，但分析返回 mock 数据
const buffer = await vision.captureScreen();
// buffer 是 PNG 格式的图像数据
```

### 4.3 视觉记忆存储

```typescript
// 可以存储视觉记忆（需要手动提供描述）
const store = getVisualMemoryStore();
await store.store({
    description: '游戏画面：原神主界面',
    objects: ['角色', '地图', '任务'],
    scene: 'game',
    confidence: 0.9,
    timestamp: new Date().toISOString(),
});
```

## 5. 完整集成 (需要模型)

当视觉模型可用时，VisionService 会自动:

1. 分析截屏内容
2. 生成场景描述
3. 检测物体
4. 存储视觉记忆
5. 在对话中提供视觉上下文

## 6. 性能优化

### GPU 加速

```bash
# 确保安装了 CUDA 版本的 llama.cpp
# 或使用 node-llama-cpp 的 GPU 支持
```

### 降低分辨率

```bash
# 在 .env 中设置
VISION_MAX_IMAGE_SIZE=1280  # 降低分辨率以加快处理
```

### 增加捕获间隔

```bash
VISION_CAPTURE_INTERVAL=10000  # 10秒捕获一次
```

## 7. 故障排除

### 问题: 模型加载失败

```bash
# 检查模型文件是否存在
ls -la models/

# 检查模型格式
file models/qwen2-vl-2b-instruct-q4_k_m.gguf
```

### 问题: GPU 内存不足

```bash
# 使用更小的量化
# Q4_K_M -> Q3_K_S
VISION_MODEL_PATH=../models/qwen2-vl-2b-instruct-q3_k_s.gguf
```

### 问题: 截屏失败

```bash
# Windows 需要管理员权限
# 或使用替代方案: nircmd, screenshot-cli
```

## 8. 临时禁用视觉功能

如果暂时不需要视觉功能:

```bash
# 在 .env 中设置
VISION_ENABLED=false
```

服务会跳过视觉相关处理，不影响其他功能。
