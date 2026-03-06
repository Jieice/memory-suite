# `.env` 中文说明（直播实战版）

下面只放最常用、最关键的参数，方便你快速调。

## 1) 快慢路模型策略

- `USE_LOCAL_LLM=true`  
  开启本地模型（快路秒回）。

- `LOCAL_LLM_MODEL_PATH=...Qwen3-4B...gguf`  
  本地快路模型路径。

- `SLOW_PATH_CLOUD_ENABLED=true`  
  允许慢路走云端。

- `SLOW_PATH_CLOUD_ALWAYS=true`  
  慢路固定优先云端（复杂问题更稳）。

- `DEEPSEEK_API_KEY=...`  
  云端 API key。

## 2) 快路性能参数（你现在主用）

- `FAST_PATH_SKIP_MEMORY=false`  
  不全局跳过记忆，是否跳过由“简单度阈值”自动决定。

- `FAST_PATH_SKIP_AGENT_CORE=false`  
  不全局跳过 Agent Core，简单请求自动旁路。

- `FAST_PATH_SKIP_BRAINNN=false`  
  不全局跳过 BrainNN，简单请求自动旁路。

- `FAST_PATH_SKIP_OPTIONAL=false`  
  不全局跳过可选重模块，简单请求自动旁路。

- `FAST_PATH_SIMPLE_COMPLEXITY_THRESHOLD=0.14`  
  “简单请求”判定阈值。低于此值才走极简链路。

- `ROUTE_COMPLEXITY_THRESHOLD=0.38`  
  初始快慢路阈值。更低意味着更容易把复杂问题送到慢路云端。

## 3) 生成长度（影响延迟）

- `LLM_FAST_MAX_TOKENS=56`
- `FAST_REPLY_MAX_WORDS=12`

快路回复越短，速度越稳；慢路仍会给更完整回复。

## 4) TTS（SoVITS）

- `TTS_ENGINE=sovits`
- `SOVITS_API_URL=http://127.0.0.1:9880`
- `SOVITS_REF_AUDIO=...`
- `SOVITS_REF_TEXT=...`

## 5) 下播自动 Sleep Mode

- `SLEEP_MODE_AUTO_ENABLED=true`  
  启用自动下播学习任务（定时触发）。

- `SLEEP_MODE_AUTO_TIME=04:10`  
  每天触发时间（本机时间）。

- `SLEEP_MODE_AUTO_CHECK_INTERVAL_MS=30000`  
  轮询间隔，默认 30 秒。

## 6) 变更后生效

```powershell
npx pm2 restart memory-universe memory-manager --update-env
```
