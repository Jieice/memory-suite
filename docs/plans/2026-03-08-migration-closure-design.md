# 2026-03-08 重构收口设计稿

## 1. 背景

本项目原本是一个多语言并存的系统，能力分散在 Rust、TypeScript/React、Python、JavaScript 及大量脚本中。当前重构方向已经基本明确：

- **Rust** 作为统一运行时与后端主控
- **React + TypeScript** 作为统一控制面与展示层
- **少量 Python** 保留为边缘能力执行器
- 逐步收缩旧 JavaScript 与历史脚本层

当前阶段的核心问题，已经不是“是否继续 Rust 化”，而是：

1. 新架构已成型，但仍有大量 **TODO / placeholder / 演示态逻辑**
2. 旧 Python / JS / scripts 仍大量共存，**迁移遗留未正式治理**
3. 核心链路虽已接入新 runtime，但 **状态机、协作机制、错误语义仍偏中间态**

因此，下一阶段重点应从“继续搭新架构”切换到：

> **围绕核心链路，完成迁移中间态收口。**

## 2. 设计目标

下一阶段目标不是追求语言占比，而是完成以下四件事：

### 2.1 核心链路闭环
优先保证以下主链路可稳定运行、状态一致、失败可见：

- chat / session / memory
- speech / live2d
- danmaku
- job / adapter

### 2.2 迁移遗留纳入治理
对 Python、JavaScript、scripts、TODO/placeholder 建立正式分类：

- 长期保留
- 继续迁移
- 冻结
- 删除

### 2.3 明确技术职责边界
正式固化三层结构：

- Rust：唯一运行时中枢
- React/TS：唯一控制面与展示面
- Python：边缘能力执行器

### 2.4 阻止旧体系继续扩散
从下一阶段开始，停止把旧 JS、非制度化 Python、历史脚本继续扩展成事实上的主系统。

## 3. 非目标

以下内容 **不属于** 本阶段重点：

- 不追求一次性清理全仓所有历史代码
- 不追求把全部 Python 重写成 Rust
- 不追求先把前端体验做成最终产品形态
- 不追求一次性补完所有 TODO
- 不进行大规模推倒重写

本阶段本质上是 **收口治理**，不是全盘翻新。

## 4. 当前状态判断

项目已经完成了最重要的架构转向：

### 已成立的部分
- Rust daemon 已接管主要 runtime 逻辑
- React 控制台已形成统一操作入口
- Rust ↔ TS 共享类型链路已建立
- Python 已出现明显边缘化趋势
- SQLite 持久化已承接大量系统状态

### 尚未完成的部分
- 核心链路中仍存在 TODO、占位实现、演示态逻辑
- job / adapter / speech / danmaku 的状态推进还偏“约定式”
- 大量 scripts 与旧 JS 资产仍未完成分类与冻结
- Python 中仍混有运行时、模型资产、历史版本目录、打包 runtime
- 部分接口模型已面向未来，但实际行为仍停留在中间态

因此，系统状态可准确描述为：

> **架构骨架已立住，但迁移中间态仍较厚。**

## 5. 总体设计原则

### 5.1 核心链路优先
一切修复、补完、迁移优先级都由四条核心链路决定。

### 5.2 职责统一优先于语言统一
不是因为某段代码能 Rust 化就先迁 Rust，而是因为该职责应归属于运行时主控层。

### 5.3 保留 Python，但限制其角色
Python 可以长期保留，但必须只承担边缘能力执行，不再承担系统主控。

### 5.4 冻结旧遗留扩张
所有旧 JS、旧脚本、临时桥接逻辑默认不再扩展。

### 5.5 TODO / placeholder 必须分级
不再“见到一个修一个”，而按阻断程度治理。

## 6. 职责边界设计

### 6.1 Rust：唯一运行时中枢
Rust 长期负责：

- session / message / memory / job / adapter / tts / live2d / danmaku 的状态真相
- lifecycle 与 orchestration
- REST / WebSocket API
- runtime event
- 错误记录与状态回写
- 配置与持久化

#### Rust 不应继续承担
- 过多演示态硬编码
- 未标注归宿的 placeholder
- 本该属于配置层的产品参数
- 为历史脚本长期兜底的兼容分支

### 6.2 React / TypeScript：唯一控制面
React 长期负责：

- 操作台
- 运行时总览
- job / adapter 控制
- speech / live2d 控制
- danmaku 控制
- creator chat
- overlay 相关展示与入口

#### React 不应继续承担
- 真正的业务状态机
- 系统状态判定真相
- 长期保留的 demo 逻辑
- 绕过 Rust 直接绑定 Python 的核心流程

### 6.3 Python：边缘能力执行器
Python 长期适合保留在：

- TTS
- train / eval
- 与 Python 模型生态强绑定的能力
- 快速试验性质的推理或数据处理模块

#### Python 不应继续承担
- runtime state 推进
- API 主入口
- 多模块总控
- 前端直连后的业务真相定义

### 6.4 JavaScript：迁移遗留层
JavaScript 不再是长期主力栈，默认只能有三种去向：

- 迁到 TypeScript / React
- 迁到 Rust
- 冻结或删除

原则上不再继续扩张 JS 脚本体系。

## 7. 资产治理模型

### 7.1 Python / JS / scripts 分类
所有遗留资产必须归入以下四类之一：

1. **长期保留**
2. **继续迁移**
3. **冻结**
4. **删除**

#### 长期保留
适用于：
- train / eval / TTS 等 Python 生态强绑定能力

#### 继续迁移
适用于：
- 状态推进
- 业务编排
- runtime lifecycle
- 旧 JS/Node 控制逻辑

#### 冻结
适用于：
- 当前仍有现实价值，但不属于未来主栈的 scripts
- 仅服务迁移期的工具与辅助逻辑

#### 删除
适用于：
- 明确废弃的旧版本目录
- 已被 Rust/React 接管的旧桥接层
- 误导性 placeholder
- 已脱离主链路的历史入口

### 7.2 TODO / placeholder 分级
所有 TODO、占位、演示态逻辑统一分级：

#### P0：阻断主链路
例如：
- 流程跑不通
- 状态不回写
- adapter 完成失败不可见
- 前端显示与真实状态严重不一致

#### P1：长期演示态风险
例如：
- 硬编码 session
- 单 backend 强制策略但接口假装可配置
- 占位 adapter
- 宽松 readiness 语义

#### P2：非核心不完善
例如：
- 次要页面
- 辅助工具
- 非主链路优化项

## 8. 核心链路收口策略

下一阶段只围绕四条链路推进：

### 8.1 Chat / Session / Memory
目标：
- session 语义明确
- memory 读取路径稳定
- fallback 行为边界清晰
- chat response 模型与真实行为一致

### 8.2 Speech / Live2D
目标：
- TTS enqueue → worker → 音频回写 → 播放状态闭环
- live2d 字幕/情绪与 speech 状态一致
- 硬编码语音策略显式化或配置化

### 8.3 Danmaku
目标：
- source config / bootstrap / connect / disconnect 路径闭环
- reconnect 语义清晰
- connection state 更接近正式状态机

### 8.4 Job / Adapter
目标：
- adapter 生命周期明确
- 占位逻辑显式分类
- 完成/失败语义清楚
- 前端状态与后端状态一致

## 9. 30 天执行节奏

### 第 1 周：盘点与冻结
目标：先管住局面。

输出：
- Python / JS / scripts / TODO 清单
- 四类资产分类表
- P0 / P1 / P2 分级表
- 冻结规则

### 第 2 周：补 job/adapter + speech/live2d
目标：先处理最能暴露迁移中间态的问题。

输出：
- adapter lifecycle 定义
- speech lifecycle 定义
- 保留 Python 能力名单
- placeholder 清单

### 第 3 周：补 chat/session/memory + danmaku
目标：收核心业务主链和最复杂连接态链路。

输出：
- chat / session / memory 状态流说明
- danmaku 状态流说明
- 前后端状态认知差异清单
- 已闭环的 P0/P1 问题列表

### 第 4 周：统一清理与边界固化
目标：完成第一轮正式收口。

输出：
- 最终遗留资产分类版
- 冻结/删除清单
- Python 边缘能力清单
- 前端控制面拆分候选清单

## 10. 风险与约束

### 风险 1：脚本层继续膨胀
如果不先冻结，旧 scripts 会继续变成事实控制平面。

### 风险 2：placeholder 长期留在主链路
会导致接口模型与真实行为持续偏离。

### 风险 3：为了“语言纯度”错误重写
如果过度追求 Rust 化，可能浪费在低收益重写上。

### 风险 4：前端控制面继续泥团化
如果 Runtime 页面继续扩功能但不做边界治理，后续成本会迅速升高。

## 11. 验收标准

当本阶段结束时，应满足以下条件：

### 架构层面
- Rust 明确是唯一 runtime 中枢
- React 明确是唯一控制面
- Python 明确只承担边缘能力

### 资产治理层面
- Python / JS / scripts 全部完成分类
- 旧 JS 默认冻结
- `_OLD` / 冗余目录 / 旧桥接层已有明确处理结论

### 功能层面
- 四条核心链路具备稳定闭环
- P0 问题基本清零
- P1 问题有明确归宿

### 组织层面
- 后续任何重构都能挂靠到核心链路与资产分类体系，而不是再回到“凭感觉推进”

## 12. 结论

本项目下一阶段的正确方向，不是继续泛化地“做 Rust 重构”，而是：

> **以 Rust + React 为主轴，对迁移中间态进行一次系统收口。**

它的核心任务不是语言替换本身，而是：

- 核心链路闭环
- 遗留资产治理
- 职责边界制度化
- TODO / placeholder 分级处理
- 阻止旧体系继续扩散

这一步做完，项目才会真正从“架构已经转向”进入“可稳定演进的新系统”。
