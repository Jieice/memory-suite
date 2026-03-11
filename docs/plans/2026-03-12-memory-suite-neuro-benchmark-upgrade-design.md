# Memory Suite Neuro-sama 对标长期升级设计

**Goal:** 基于 2026 年 3 月 12 日前可验证的公开资料与当前仓库真实运行面，为 Memory Suite 制定一条以“角色吸引力 + 节目持续性 + 技术支撑”为核心的长期升级路线。

## 1. 结论先行

本设计选择的主路线不是“先追求更强 AI 能力”，而是：

1. 先把角色内核接入主链
2. 再把直播存在感和节目节奏做出来
3. 最后补多模态、自治、游戏与 IP 外延

原因很直接：

- Neuro-sama 被喜欢，不只是因为“她是 AI”
- 公开可见的长期优势来自角色稳定度、节目形态、创作者关系、社区仪式和持续成长感
- 当前 Memory Suite 的主要短板不在 Live2D 或 TTS 能不能工作，而在主链仍然更像“直播运行时助手”，不像“角色本人”

## 2. 研究边界

### 2.1 外部研究边界

只使用以下几类公开信息：

- 官方入口、官方页面、官方仓库
- 可验证的公开平台信息
- 公开媒体分析
- 公开社区讨论

不把任何未经公开证实的私有实现细节当作事实。

### 2.2 内部评估边界

只按当前仓库中已经接线并可验证的运行面评估，不把旧 spec、历史路线图、未来构想当成“已实现能力”。

## 3. 外部事实基线

### 3.1 截至 2026 年 3 月 12 日可验证的 Neuro-sama 公开形态

- 官方链接页显示其公开生态已覆盖 Twitch、JP Twitch、Bilibili、YouTube、X、Spotify、Discord、GitHub、周边与灯控应用，而不是单一直播页面。
- 官方 GitHub `neuro-sdk` 已公开，且明确包含 Unity / Godot SDK，定位是“让 Neuro 玩游戏”的官方开发接口。
- Wikipedia 在 2026 年 3 月 8 日更新的公开资料中，将 Neuro-sama 描述为跨平台的 AI VTuber / streamer，内容类型覆盖 gaming、chatting、singing，并明确区分了 `Neuro-sama` 与 `Evil Neuro` 作为独立角色。
- 官方 2026 resolutions 页面说明其角色运营已经带有长期生活化叙事，而不是只围绕单场直播。

### 3.2 外部公开信息能支持的“观众喜欢原因”

综合官方公开面、媒体分析与社区讨论，可以形成以下较稳健的判断：

1. 新奇感能吸引第一次观看，但不足以形成长期偏好。
2. 长期观看依赖角色一致性，而不是单轮回答质量。
3. 观众喜欢的是“角色关系”和“节目化碰撞”，不是孤立问答。
4. 社区 ritual、固定梗、 recurring formats 会强化复访。
5. 可见的成长轨迹会让观众感觉自己在陪角色一起进化。
6. 人工打磨出来的缺陷管理与表演包装，会把“AI 不完美”转成可爱的角色特征。

### 3.3 来源

- 官方入口: https://vedal.ai/
- 2026 目标页: https://vedal.ai/resolutions-2026.html
- 官方博客: https://vedal.ai/neuro-blog.html
- 官方碎片内容页: https://vedal.ai/bytes/
- 官方 app: https://app.vedal.ai/
- 官方 SDK: https://github.com/VedalAI/neuro-sdk
- Wikipedia: https://en.wikipedia.org/wiki/Neuro-sama
- TechRadar 分析: https://www.techradar.com/ai-platforms-assistants/ive-spent-months-tracking-ai-personalities-like-twitch-streamer-neuro-sama-and-it-feels-like-acceptance-but-i-think-were-reading-it-wrong
- 社区讨论样本: https://www.reddit.com/r/vtubers/comments/1mkpwtc/why_do_people_like_neurosama_even_though_shes_ai/

## 4. 当前项目真实基线

### 4.1 当前已经真实存在的能力

- 统一运行时已经落到 `Rust daemon + React web + Python adapter`
- Live2D overlay 已具备字幕、口型、motion timeline、播放队列、WebSocket 更新、拖拽持久化
- TTS 已进入统一链路
- Bilibili danmaku 接入、心跳、重连、native websocket session 已进入 Rust gateway
- Creator backstage 页面已经存在，可作为后续导演台入口

### 4.2 当前已验证的关键短板

1. 主 orchestrator 的默认身份仍然偏 assistant
2. 远端 LLM fallback 预算极短，容易掉回内建模板输出
3. 运行时数据库中当前 `memory_entries = 0`、`user_profiles = 0`、`config_artifacts = 0`
4. `data/memories/global/PERSONALITY.md` 存在，但当前主链未显示出稳定消费它的路径
5. emotion / viseme / motion 仍主要依赖启发式映射
6. 当前 creator 通道更像控制台，不像人格导演层

### 4.3 当前观感判断

如果只按当前真实运行面评估：

- 面向观众的 Neuro-sama 体验对标：约 25%–35%
- 内部工程和控制台成熟度：约 55%–65%
- 人格稳定度 / 主播感 / 持续在场感：约 15%–25%

这个判断是推论，不是官方数值；推论依据是当前仓库能力边界与外部公开形态的逐项对比。

## 5. 为什么大家会留下来，而不是只来看一眼

这部分是本路线图的核心。Memory Suite 后续每一阶段都要服务这些目标，而不是反过来为技术炫技服务。

### 5.1 角色可识别性

观众需要能用几句话描述“她是什么样的人”。  
如果一个系统只能被描述为“会说话的 AI”，它就很难形成长期偏好。

### 5.2 持续在场感

观众要感觉角色不是被动触发器，而是一直在线、一直有状态、一直对场面有感觉。

### 5.3 节目节奏

长期观看依赖节目结构：

- 开场
- 热身
- 高点
- 转场
- 收尾

而不是一条条独立回答。

### 5.4 关系网络

观众喜欢看的往往不是角色本身，而是：

- 角色与 creator 的关系
- 角色与另一个人格的关系
- 角色与观众群体的关系
- 角色与固定梗/历史事件的关系

### 5.5 社区 ritual

固定梗、固定口号、固定活动和 recurring topics 会把内容消费转成社区参与。

### 5.6 可见成长

如果观众能看到版本进化、角色设定扩展、节目升级和能力变化，就会形成陪伴感与投资感。

## 6. 对标维度矩阵

| 维度 | Neuro-sama 公开可见形态 | Memory Suite 当前真实形态 | 差距性质 | 优先级 |
| --- | --- | --- | --- | --- |
| 角色身份 | 明确角色 + 反相角色 + creator 关系 | 直播运行时助手倾向明显 | 角色内核缺失 | P0 |
| 实时存在感 | 不只是答复，还会带节奏和接场子 | 响应可播，但空闲态很弱 | 体验与状态层缺失 | P0 |
| 演出密度 | 语气、节目感、段落感明显 | 字幕+口型+简单 motion | 表演系统粗糙 | P0 |
| 人格稳定度 | 观众可识别且长期稳定 | 人设文件未接主链 | 系统接线缺失 | P0 |
| 节目形态 | 游戏、唱歌、collab、活动多样 | 主要是 runtime 驱动的对话与控制 | 节目系统缺失 | P1 |
| 社区 ritual | 强，且跨平台沉淀 | 当前几乎没有 | 社区设计缺失 | P1 |
| 关系网络 | creator / Evil Neuro / collab 强 | creator backstage 已有，但不是剧情/关系系统 | 关系层缺失 | P1 |
| 多模态场景反应 | 已有游戏与多平台节目外延 | 暂无真实视觉上下文接入 | 能力缺失 | P2 |
| 游戏能力 | 官方 SDK 已公开 | 当前无真实游戏回路 | 能力缺失 | P2 |
| IP 外延 | 音乐、blog、周边、app | 当前主要是 runtime 产品 | 内容运营缺失 | P2 |

## 7. 长期升级原则

### 7.1 角色优先于能力

先让她像一个人，再让她像一个更强的 AI。

### 7.2 节目优先于工具

观众不为工具链买单，只为体验买单。

### 7.3 关系优先于知识

比起“答得更全”，长期价值更来自“关系更真”。

### 7.4 可观测优先于幻想

每一阶段都必须定义指标和验证方式，避免把“写进 spec”误当成“已经形成体验”。

### 7.5 小步快跑，避免一次性做全栈 Neuro

官方 SDK 公开说明了高层决策与低层实时动作应分层。Memory Suite 不应在角色内核尚未成立前就跳去追高 APM 游戏代理。

## 8. 分阶段路线图

### 阶段 0：角色内核接入主链

**时间:** 2–3 周

**目标:** 停止把当前主链继续当作“直播助手”，建立单一 persona canon 和导演控制面。

**必须完成:**

- 单一 persona canon 真源
- runtime 可读的人设、态度、说话结构、短反馈词库
- creator backstage 升级为导演台入口
- 合理的 LLM fallback 策略
- fallback / remote / builtin 路径可观测

**阶段门槛:**

- 角色输出不再频繁掉回模板助手腔
- 同类输入下风格稳定
- 创作者可以通过后台直接调 persona mode

### 阶段 1：把“她在场”做出来

**时间:** 1–2 个月

**目标:** 从“可播”升级到“有直播感”。

**必须完成:**

- 短反馈层
- 空闲态主动存在
- 回答后推进一句
- 直播模式状态机
- 句中表演点

**阶段门槛:**

- 首反应延迟和整答延迟分层
- 空闲态不再是静止无生命
- 观众感知到“她在接场子”

### 阶段 2：人格稳定度与关系层

**时间:** 2–3 个月

**目标:** 让观众能稳定识别角色、对不同对象有不同态度。

**必须完成:**

- 人格锚点收敛
- 态度层规则
- relationship memory
- viewer memory
- session summary 与 live state memory
- drift test 套件

**阶段门槛:**

- 30+ 轮人设不漂
- 对 creator / viewer / low quality input 呈现不同态度

### 阶段 3：节目与社区飞轮

**时间:** 3–6 个月

**目标:** 从“角色会说话”升级到“角色有节目”。

**必须完成:**

- 固定栏目
- recurring segments
- clip-first 场景设计
- 社区 ritual
- collab protocol
- 版本成长日志

**阶段门槛:**

- 能稳定跑一场有结构的直播
- 社区开始形成固定梗和固定活动预期

### 阶段 4：多模态与场景自治

**时间:** 4–8 个月

**目标:** 让角色能持续感知环境并围绕场景输出。

**必须完成:**

- 视觉上下文接入
- 场景事件总线
- scene commentary loop
- 高层行动回路
- 低频可控的自治 comment

**阶段门槛:**

- 对当前画面和直播状态持续有评论
- 不再完全依赖用户主动提问

### 阶段 5：角色 IP 化

**时间:** 6–12 个月

**目标:** 让角色存在于直播之外。

**必须完成:**

- 角色世界观扩展
- 音乐 / cover / 短内容流程
- blog / diary / recipes / event pages
- 多平台内容复用
- 周边或互动资产

**阶段门槛:**

- 非直播内容也能独立承载角色存在感

## 9. 关键指标体系

### 9.1 角色指标

- persona drift rate
- 态度层命中率
- 口头锚点稳定率
- 追问 / 推进一句比率

### 9.2 直播指标

- 首反应延迟
- 主回复延迟
- 空闲态触发率
- 场景接续率
- clip 候选触发率

### 9.3 社区指标

- 回访率
- 长会话占比
- ritual 参与率
- 固定梗复现率

### 9.4 产品指标

- remote LLM 成功率
- fallback 命中率
- builtin response 比例
- TTS 成功率
- speech queue 连续播放成功率

## 10. 风险与控制

### 10.1 最大风险：误把“更多能力”当成“更有吸引力”

控制办法：

- 先做阶段 0 和阶段 1
- 不在角色内核没立住前追求大而全多模态

### 10.2 第二风险：人设写了，但没接到主链

控制办法：

- persona canon 必须有明确真源
- prompt builder、导演台、runtime state 都必须消费同一套设定

### 10.3 第三风险：导演层太重，直播反而卡顿

控制办法：

- 快反应与完整回复分层
- 策略规则 deterministic first
- 避免 phase 0 就做重代理

## 11. 本阶段最值得落地的执行范围

虽然本设计覆盖 12 个月路线，但当前最应该进入实现的是：

1. persona canon 真源
2. orchestrator prompt 与 fallback 重构
3. creator backstage 导演参数
4. runtime persona / fallback observability

这是整个长期路线的基础层。没有这一层，后续短反馈、空闲态和节目系统都只会继续叠在“助手主链”上。

## 12. 仓库证据附录

### 12.1 当前统一运行时

- `README.md`
- `docs/UNIFIED_RUST_RUNTIME.md`
- `apps/daemon/src/lib.rs`

### 12.2 当前 Live2D overlay

- `apps/web/overlays/live2d.html`
- `crates/media/src/lib.rs`

### 12.3 当前 orchestrator 主链

- `crates/orchestrator/src/lib.rs`
- `config/app.toml`

### 12.4 当前后台与控制面

- `apps/web/src/pages/CreatorChatPage.tsx`
- `apps/web/src/pages/RuntimePage.tsx`

### 12.5 当前运行时数据库事实

截至 2026 年 3 月 12 日本地检查结果：

- `messages = 1549`
- `tts_requests = 782`
- `memory_entries = 0`
- `user_profiles = 0`
- `config_artifacts = 0`

这说明“长期人格与记忆已接入主链”目前不能被当作既成事实。
