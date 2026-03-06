// emotion-enhancer.js - AI情绪增强器
// 基于现有系统，添加智能情绪检测和表情控制

class EmotionEnhancer {
    constructor() {
        // 根据实际观察修正的情绪映射表
        this.emotionMap = {
            'happy': 'f02',      // 开心 → 微笑
            'sad': 'f03',        // 难过 → 难过表情
            'angry': 'f04',      // 生气 → 生气表情
            'surprised': 'f05',  // 惊讶 → 闭眼微笑
            'normal': 'f01',     // 普通 → 普通表情
            'excited': 'f02',    // 兴奋 → 微笑
            'shy': 'f01',        // 害羞 → 普通表情（你说俏皮是害羞，这里调整）
            'playful': 'f01',    // 俏皮 → 害羞表情（根据你的观察）
            'thoughtful': 'f01', // 思考 → 普通表情
            'confused': 'f05',   // 困惑 → 闭眼微笑
            'proud': 'f02',      // 自豪 → 微笑
            'worried': 'f03',    // 担心 → 难过表情
            'curious': 'f05'     // 好奇 → 闭眼微笑
        };

        // 动作映射表 - 修复版本
        this.motionMap = {
            'happy': 'TapBody',
            'excited': 'TapBody', 
            'playful': 'TapBody',
            'proud': 'TapBody',
            'sad': 'Idle',
            'worried': 'Idle',
            'angry': 'TapBody',  // 修复：生气也用TapBody
            'surprised': 'TapBody',
            'confused': 'TapBody',
            'curious': 'TapBody',
            'thoughtful': 'Idle',
            'shy': 'Idle',
            'normal': 'Idle'
        };

        // 情绪关键词检测
        this.emotionKeywords = {
            'happy': ['开心', '高兴', '快乐', '哈哈', '嘿嘿', '😊', '😄', '😆', '👍'],
            'excited': ['兴奋', '激动', '太棒了', '厉害', '哇塞', '🎉', '✨'],
            'playful': ['俏皮', '调皮', '嘻嘻', '略略略', '😜', '😏'],
            'sad': ['难过', '伤心', '哭', '呜呜', '😢', '😭', '💔'],
            'angry': ['生气', '愤怒', '气死了', '讨厌', '😠', '😡', '💢'],
            'surprised': ['惊讶', '震惊', '哇', '天哪', '不会吧', '😲', '😱'],
            'confused': ['困惑', '疑惑', '不懂', '什么', '？？？', '🤔'],
            'worried': ['担心', '忧虑', '紧张', '害怕', '😰', '😟'],
            'proud': ['自豪', '骄傲', '厉害吧', '不错吧', '😎', '💪'],
            'curious': ['好奇', '想知道', '是什么', '怎么样', '🤨'],
            'thoughtful': ['思考', '想想', '让我想想', '嗯', '🤔'],
            'shy': ['害羞', '不好意思', '羞羞', '😳', '🙈']
        };
    }

    // 从AI回复中检测情绪
    detectEmotionFromText(text) {
        if (!text) return 'normal';

        // 计算每种情绪的匹配分数
        const scores = {};
        
        for (const [emotion, keywords] of Object.entries(this.emotionKeywords)) {
            scores[emotion] = 0;
            
            for (const keyword of keywords) {
                if (text.includes(keyword)) {
                    scores[emotion] += 1;
                }
            }
        }

        // 找到得分最高的情绪
        let maxScore = 0;
        let detectedEmotion = 'normal';
        
        for (const [emotion, score] of Object.entries(scores)) {
            if (score > maxScore) {
                maxScore = score;
                detectedEmotion = emotion;
            }
        }

        console.log('🎭 情绪检测结果:', { text: text.substring(0, 50), detectedEmotion, scores });
        return detectedEmotion;
    }

    // 应用情绪到Live2D模型 - 修复版本
    applyEmotion(emotion, model, skipMouth = false) {
        if (!model || !model.internalModel) {
            console.warn('❌ 模型未初始化，无法应用情绪');
            return false;
        }

        try {
            console.log(`🎭 开始应用情绪: ${emotion}`);
            
            // 1. 设置表情
            const expression = this.emotionMap[emotion] || 'f01';
            this.setExpression(model, expression);
            
            // 2. 触发动作 - 直接使用映射的动作组
            const motionGroup = this.motionMap[emotion] || 'Idle';
            this.playMotionWithForce(model, motionGroup, emotion);
            
            // 3. 嘴型动画由TTS播放时控制，这里不触发
            // （除非明确要求触发）
            if (!skipMouth) {
                console.log('⏭️ 跳过嘴型动画，等待TTS播放时触发');
            }
            
            console.log(`✅ 情绪应用完成: ${emotion} → 表情:${expression}, 动作:${motionGroup}`);
            return true;
            
        } catch (error) {
            console.error('❌ 应用情绪失败:', error);
            return false;
        }
    }

    // 设置表情 - 独立方法
    setExpression(model, expression) {
        try {
            model.expression(expression);
            console.log(`✅ 表情设置: ${expression}`);
        } catch (error) {
            console.warn(`⚠️ 表情设置失败: ${expression} - ${error.message}`);
        }
    }

    // 强制播放动作 - 改进版本
    playMotionWithForce(model, motionGroup, emotion) {
        try {
            // 步骤1: 临时禁用鼠标跟随
            const originalTrackerState = this.disableMouseTracking(model);
            
            // 步骤2: 停止当前动作
            this.stopCurrentMotions(model);
            
            // 步骤3: 延迟播放新动作（确保停止完成）
            setTimeout(() => {
                this.executeMotion(model, motionGroup, emotion);
                
                // 步骤4: 延迟恢复鼠标跟随
                setTimeout(() => {
                    this.restoreMouseTracking(model, originalTrackerState);
                }, 3000);
            }, 100);
            
        } catch (error) {
            console.error(`❌ 强制播放动作失败: ${error.message}`);
        }
    }

    // 禁用鼠标跟随
    disableMouseTracking(model) {
        try {
            if (model.tracker) {
                const originalState = model.tracker.enabled;
                model.tracker.enabled = false;
                console.log('🚫 已禁用鼠标跟随');
                return originalState;
            }
        } catch (error) {
            console.warn(`⚠️ 禁用鼠标跟随失败: ${error.message}`);
        }
        return true; // 默认状态
    }

    // 恢复鼠标跟随
    restoreMouseTracking(model, originalState) {
        try {
            if (model.tracker) {
                model.tracker.enabled = originalState;
                console.log('✅ 已恢复鼠标跟随');
            }
        } catch (error) {
            console.warn(`⚠️ 恢复鼠标跟随失败: ${error.message}`);
        }
    }

    // 停止当前动作
    stopCurrentMotions(model) {
        try {
            if (model.internalModel && model.internalModel.motionManager) {
                model.internalModel.motionManager.stopAllMotions();
                console.log('🛑 已停止所有当前动作');
            }
        } catch (error) {
            console.warn(`⚠️ 停止动作失败: ${error.message}`);
        }
    }

    // 执行动作 - 多种方法尝试
    executeMotion(model, motionGroup, emotion) {
        const motionIndex = this.getMotionIndex(emotion);
        
        // 方法1: 标准调用
        try {
            model.motion(motionGroup, motionIndex);
            console.log(`✅ 动作播放成功 (标准): ${motionGroup}[${motionIndex}]`);
            return;
        } catch (error1) {
            console.warn(`⚠️ 标准动作调用失败: ${error1.message}`);
        }

        // 方法2: 高优先级调用
        try {
            model.motion(motionGroup, motionIndex, 10); // 最高优先级
            console.log(`✅ 动作播放成功 (高优先级): ${motionGroup}[${motionIndex}]`);
            return;
        } catch (error2) {
            console.warn(`⚠️ 高优先级动作调用失败: ${error2.message}`);
        }

        // 方法3: 使用TapBody作为备选
        if (motionGroup !== 'TapBody') {
            try {
                model.motion('TapBody', 0, 10);
                console.log(`✅ 动作播放成功 (备选): TapBody[0]`);
                return;
            } catch (error3) {
                console.warn(`⚠️ 备选动作调用失败: ${error3.message}`);
            }
        }

        // 方法4: 直接操作内部API
        try {
            this.forceMotionViaInternalAPI(model, motionGroup, motionIndex);
        } catch (error4) {
            console.error(`❌ 所有动作播放方法都失败了`);
        }
    }

    // 根据实际测试结果的动作索引映射
    getMotionIndex(emotion) {
        // 完整的动作映射 - 已全部测试确认
        const indexMap = {
            // 基础情绪
            'normal': 0,       // idle/普通
            'happy': 4,        // 微笑
            'sad': 9,          // 难过
            'angry': 8,        // 生气
            'surprised': 6,    // 惊讶
            'excited': 5,      // 兴奋/抬起双手
            'shy': 3,          // 害羞
            'playful': 3,      // 俏皮=害羞
            
            // 扩展情绪
            'thoughtful': 1,   // 思考/歪头疑惑
            'confused': 1,     // 困惑=歪头疑惑
            'curious': 1,      // 好奇=歪头疑惑
            'worried': 2,      // 担心/身体摇摆
            'proud': 5,        // 自豪=抬起双手
            
            // 特殊动作
            'performance': 12, // 唱歌/表演
            'singing': 12,     // 唱歌
            'mic_off': 10,     // 麦克风关闭
            'mic_on': 11       // 麦克风打开/显示麦克风
        };
        return indexMap[emotion] || 0;
    }

    // 通过内部API强制播放动作
    forceMotionViaInternalAPI(model, motionGroup, motionIndex) {
        try {
            const motionManager = model.internalModel.motionManager;
            const settings = model.internalModel.settings;
            
            if (motionManager && settings && settings.motions && settings.motions[motionGroup]) {
                const motions = settings.motions[motionGroup];
                if (motions[motionIndex]) {
                    console.log(`🔧 尝试内部API播放: ${motionGroup}[${motionIndex}]`);
                    
                    // 尝试直接调用内部方法
                    if (typeof motionManager.startMotion === 'function') {
                        motionManager.startMotion(motionGroup, motionIndex, 10);
                        console.log(`✅ 内部API播放成功`);
                    }
                }
            }
        } catch (error) {
            console.warn(`⚠️ 内部API播放失败: ${error.message}`);
        }
    }

    // 触发嘴型动画 - 增强版本
    triggerMouthAnimation(model, duration = 2000, speed = 20) {
        try {
            const coreModel = model.internalModel.coreModel;
            if (!coreModel) {
                console.warn('⚠️ 核心模型未找到，无法播放嘴型动画');
                return;
            }

            // 停止之前的嘴型动画
            if (this._mouthAnimationId) {
                cancelAnimationFrame(this._mouthAnimationId);
                this._mouthAnimationId = null;
            }

            let startTime = Date.now();
            const animate = () => {
                const elapsed = Date.now() - startTime;
                if (elapsed > duration) {
                    this.setMouthValue(model, 0);
                    this._mouthAnimationId = null;
                    console.log('✅ 嘴型动画完成');
                    return;
                }

                const progress = elapsed / duration;
                // 嘴型速度可调整：speed参数控制开合频率
                // speed=12 较慢，speed=20 正常，speed=30 较快
                const mouthValue = Math.sin(progress * Math.PI * speed) * 0.8 + 0.8; // 0-1.6之间
                this.setMouthValue(model, Math.abs(mouthValue) * 2); // 0-3.2之间

                this._mouthAnimationId = requestAnimationFrame(animate);
            };

            this._mouthAnimationId = requestAnimationFrame(animate);
            console.log(`🎤 开始嘴型动画 (${duration}ms, 速度:${speed})`);
        } catch (error) {
            console.error(`❌ 嘴型动画失败: ${error.message}`);
        }
    }

    // 同步字幕的嘴型动画
    syncMouthWithSubtitle(model, text) {
        if (!text || !model) return;
        
        // 根据文本长度计算动画时长
        const duration = Math.max(1000, text.length * 100); // 每个字符100ms，最少1秒
        
        console.log(`🎤 同步字幕嘴型: "${text.substring(0, 20)}..." (${duration}ms)`);
        this.triggerMouthAnimation(model, duration);
    }

    // 处理AI回复并自动应用情绪（不触发嘴型）
    processAIResponse(text, model) {
        // 检测情绪
        const emotion = this.detectEmotionFromText(text);
        
        // 应用到模型（跳过嘴型动画）
        if (model) {
            this.applyEmotion(emotion, model, true);
        }
        
        // 发送到服务器记录
        this.sendEmotionToServer(emotion, text);
        
        return emotion;
    }

    // TTS播放时触发嘴型动画
    startMouthSyncWithAudio(model, audioDuration, speed = 20) {
        if (!model) return;
        
        console.log(`🎤 TTS播放中，开始嘴型同步 (${audioDuration}ms, 速度:${speed})`);
        this.triggerMouthAnimation(model, audioDuration, speed);
    }

    // 停止嘴型动画
    stopMouthSync(model) {
        if (this._mouthAnimationId) {
            cancelAnimationFrame(this._mouthAnimationId);
            this._mouthAnimationId = null;
        }
        if (model) {
            this.setMouthValue(model, 0);
        }
        console.log('🛑 停止嘴型动画');
    }

    // 发送情绪到服务器
    async sendEmotionToServer(emotion, text) {
        try {
            // 使用相对路径，自动使用当前页面的 host
            await fetch('/api/emotion', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    emotion, 
                    text: text.substring(0, 100),
                    timestamp: Date.now()
                })
            });
        } catch (error) {
            console.warn('发送情绪到服务器失败:', error);
        }
    }

    // 手动触发情绪（用于测试）
    triggerEmotion(emotion, model) {
        console.log(`🎭 手动触发情绪: ${emotion}`);
        return this.applyEmotion(emotion, model);
    }

    // 获取支持的情绪列表
    getSupportedEmotions() {
        return Object.keys(this.emotionMap);
    }

    // 检查模型信息（调试用）
    inspectModel(model) {
        if (!model || !model.internalModel) {
            console.log('❌ 模型未初始化');
            return null;
        }

        try {
            const settings = model.internalModel.settings;
            const coreModel = model.internalModel.coreModel;
            
            const info = {
                modelUrl: settings?.url || 'unknown',
                hasSettings: !!settings,
                hasCoreModel: !!coreModel,
                motionGroups: settings?.motions ? Object.keys(settings.motions) : [],
                expressions: settings?.expressions ? settings.expressions.map(exp => exp.Name || exp.name) : [],
                parameters: []
            };

            // 获取参数信息
            if (coreModel) {
                try {
                    const paramCount = coreModel.getParameterCount();
                    for (let i = 0; i < Math.min(paramCount, 20); i++) { // 只显示前20个参数
                        const paramId = coreModel.getParameterId(i);
                        const paramValue = coreModel.getParameterValue(i);
                        info.parameters.push({ id: paramId, value: paramValue });
                    }
                } catch (paramError) {
                    console.warn('获取参数信息失败:', paramError);
                }
            }

            console.log('🔍 模型详细信息:', info);
            return info;
        } catch (error) {
            console.error('检查模型信息失败:', error);
            return null;
        }
    }

    // 测试嘴型动画
    testMouthAnimation(model, duration = 3000) {
        if (!model || !model.internalModel) {
            console.warn('模型未初始化，无法测试嘴型');
            return;
        }

        console.log('🎤 开始测试嘴型动画...');
        
        let startTime = Date.now();
        const animate = () => {
            const elapsed = Date.now() - startTime;
            if (elapsed > duration) {
                // 重置嘴型
                this.setMouthValue(model, 0);
                console.log('✅ 嘴型测试完成');
                return;
            }

            // 生成波形嘴型动画
            const progress = elapsed / duration;
            const mouthValue = Math.sin(progress * Math.PI * 10) * 0.5 + 0.5; // 0-1之间的波形
            this.setMouthValue(model, mouthValue * 3); // 转换为0-3范围

            requestAnimationFrame(animate);
        };

        animate();
    }

    // 设置嘴型值 - 强化版本
    setMouthValue(model, value) {
        if (!model || !model.internalModel) return;

        try {
            value = Math.max(0, Math.min(value, 3.0));
            const coreModel = model.internalModel.coreModel;

            let success = false;
            
            // 方法1: 直接通过ID设置
            try {
                coreModel.setParameterValueById('ParamMouthOpenY', value);
                success = true;
                console.log(`✅ 嘴型参数设置成功 (ID): ParamMouthOpenY = ${value}`);
            } catch (e) {
                // 方法2: 通过索引查找并设置
                try {
                    const paramCount = coreModel.getParameterCount();
                    for (let i = 0; i < paramCount; i++) {
                        const paramId = coreModel.getParameterId(i);
                        if (paramId === 'ParamMouthOpenY' || paramId.toLowerCase().includes('mouth')) {
                            coreModel.setParameterValueByIndex(i, value);
                            success = true;
                            console.log(`✅ 嘴型参数设置成功 (索引): ${paramId}[${i}] = ${value}`);
                            break;
                        }
                    }
                } catch (e2) {
                    console.warn('索引方式设置嘴型失败:', e2.message);
                }
            }

            // 方法3: 如果还是失败，尝试Live2D的内置方法
            if (!success && model.internalModel.coreModel.setMouthOpenY) {
                try {
                    model.internalModel.coreModel.setMouthOpenY(value);
                    success = true;
                    console.log(`✅ 嘴型参数设置成功 (内置方法): ${value}`);
                } catch (e3) {
                    console.warn('内置方法设置嘴型失败:', e3.message);
                }
            }

            if (!success) {
                console.warn('⚠️ 所有嘴型设置方法都失败了');
                // 只在第一次失败时输出调试信息
                if (!this._debugOutputDone) {
                    this._debugOutputDone = true;
                    try {
                        const paramCount = coreModel.getParameterCount();
                        console.log('🔍 可用参数列表:');
                        for (let i = 0; i < Math.min(paramCount, 15); i++) {
                            const paramId = coreModel.getParameterId(i);
                            const paramValue = coreModel.getParameterValue(i);
                            console.log(`  [${i}] ${paramId}: ${paramValue}`);
                        }
                    } catch (e) {}
                }
            }
        } catch (error) {
            console.error('设置嘴型失败:', error);
        }
    }

    // 添加自定义情绪映射
    addCustomEmotion(emotion, expression, motion, keywords = []) {
        this.emotionMap[emotion] = expression;
        this.motionMap[emotion] = motion;
        this.emotionKeywords[emotion] = keywords;
        
        console.log(`✅ 添加自定义情绪: ${emotion}`);
    }

    // 强制播放动作（用于测试）
    forcePlayMotion(model, motionGroup = 'TapBody', motionIndex = 0) {
        if (!model || !model.internalModel) {
            console.warn('模型未初始化');
            return false;
        }

        try {
            console.log(`🎬 强制播放动作: ${motionGroup}[${motionIndex}]`);
            
            // 1. 停止所有动作
            if (model.internalModel.motionManager) {
                model.internalModel.motionManager.stopAllMotions();
            }
            
            // 2. 禁用鼠标跟随
            if (model.tracker) {
                model.tracker.enabled = false;
            }
            
            // 3. 强制播放动作
            model.motion(motionGroup, motionIndex, 3); // 最高优先级
            
            // 4. 延迟重新启用鼠标跟随
            setTimeout(() => {
                if (model.tracker) {
                    model.tracker.enabled = true;
                }
            }, 5000);
            
            console.log(`✅ 强制动作播放成功`);
            return true;
        } catch (error) {
            console.error('强制播放动作失败:', error);
            return false;
        }
    }

    // 测试所有可用动作
    testAllMotions(model) {
        if (!model || !model.internalModel) {
            console.warn('模型未初始化');
            return;
        }

        try {
            const settings = model.internalModel.settings;
            if (!settings || !settings.motions) {
                console.warn('没有找到动作配置');
                return;
            }

            const motionGroups = Object.keys(settings.motions);
            console.log(`🎭 开始测试所有动作组: ${motionGroups.join(', ')}`);
            
            let groupIndex = 0;
            const testNextGroup = () => {
                if (groupIndex >= motionGroups.length) {
                    console.log('✅ 所有动作测试完成');
                    return;
                }
                
                const groupName = motionGroups[groupIndex];
                const motions = settings.motions[groupName];
                
                console.log(`🎬 测试动作组: ${groupName} (${motions.length}个动作)`);
                this.forcePlayMotion(model, groupName, 0);
                
                groupIndex++;
                setTimeout(testNextGroup, 4000); // 每4秒测试一个动作组
            };
            
            testNextGroup();
        } catch (error) {
            console.error('测试动作失败:', error);
        }
    }
}

// 导出类
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { EmotionEnhancer };
} else {
    window.EmotionEnhancer = EmotionEnhancer;
}