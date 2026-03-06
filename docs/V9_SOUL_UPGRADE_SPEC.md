# Memory Suite v9.0 "The Soul Upgrade" Specification

## 1. 核心目标
将系统从“被动回复机器人”升级为“具备环境感知与自我进化能力”的智能体，对标 Neuro-sama 的理解深度。

## 2. 模块规格说明

### A. 世界模型层 (World Model & State Space)
- **WorldState 定义**:
    - `activity`: 当前活动（游戏名/杂谈主题/视频反应）。
    - `atmosphere`: 房间氛围（活跃/冷场/节奏/温馨）。
    - `hot_topics`: 最近 5 分钟弹幕高频词云。
    - `audience_pulse`: 观众平均情绪得分（由 BrainNN 实时计算聚合）。
- **同步机制**: 由 `Manager` 汇总 `Danmaku` 和 `Live2D` 状态，每 10 秒向 `BrainNN` 同步一次全量 `WorldState`。

### B. 因果思考链路 (Thinking Layer / CoT)
- **强制思考协议**: 在调用 LLM 接口时，System Prompt 强制要求模型采用以下 JSON 格式思考：
    ```json
    {
      "thinking": {
        "observation": "当前世界状态观察",
        "intent_analysis": "对方意图深层解析",
        "social_strategy": "回复后的预期反应预测"
      },
      "response": "最终输出文本"
    }
    ```
- **自修复逻辑**: 继承并增强现有的 JSON 提取器，确保即使模型输出包含 `<think>` 标签也能被正确解析。

### C. 欲望引擎与主动性 (Drive & Intrinsic Motivation)
- **DriveState 扩展**:
    - `expression_desire`: 表达欲（随时间增加，随发言减少）。
    - `curiosity`: 求知欲（随新话题出现增加）。
- **逻辑**: 当 `expression_desire > 0.8` 且直播间冷场（`Danmaku` 频率低）时，自动触发基于 `WorldState.hot_topics` 的主动话题生成。

### D. 自进化循环 (Self-Evolution Loop)
- **在线学习流水线**:
    - **Step 1**: 每日 04:00 提取 `online_pairs.jsonl` 中评分 > 0.8 的数据。
    - **Step 2**: 检查显存环境。若显存充足，使用 `Unsloth` 框架对本地 Qwen3 进行低比特 LoRA 微调。
    - **Step 3**: 自动化 A/B 测试。微调后的模型与旧模型运行 `eval:intelligence` 对比。
    - **Step 4**: 成功则自动更替 PM2 中的模型加载路径。

## 3. 待办与限制
- **多模态屏蔽**: 鉴于用户本地硬件限制，暂不集成 Vision 模型。采用“文本描述环境”替代“视觉解析画面”。
- **硬件保护**: 微调脚本需包含 `pynvml` 检查，防止直播时意外触发导致显卡崩溃。
