// Live2D Desktop Controller
class Live2DController {
    constructor() {
        this.model = null;
        this.app = null;
        this.isDragging = false;
        this.dragOffset = { x: 0, y: 0 };
        this.currentEmotion = 'normal';
        this.subtitleElement = null;
        this.lastSubtitle = '';
        this.lastAudioTimestamp = 0;
        this.isSpinning = false;
        this.spinAnimationId = null;
        this.lastSpinTime = 0;
        this.lastSpinText = '';
        this.spinCooldownMs = 8000;
        this.spinKeywords = ['\u65cb\u8f6c', '\u8f6c\u4e00\u5708', '\u8f6c\u4e2a\u5708', '\u8f6c\u5708', '\u8f6c\u8d77\u6765'];

        // TTS and streaming subtitle support
        this.audioQueue = [];
        this.isPlaying = false;
        this.currentAudio = null;
        this.subtitleTimeout = null;

        // 鏂扮殑鎵撳瓧鏈烘晥鏋滃彉閲?
        this.typingTimer = null;
        this.autoHideTimer = null;
        this.conversationEndTimer = null;

        // 妯″瀷閰嶇疆锛堝皢浠庢湇鍔″櫒鍔犺浇锛?
        this.modelConfig = {
            scale: null,
            x: null,
            y: null
        };

        // 鍢村瀷閫熷害閰嶇疆
        this.mouthSpeed = 20;

        // Use the origin directly (API is at root, not under /live2d)
        this.serverUrl = window.location.origin;
    }

    // 鍔犺浇妯″瀷閰嶇疆锛堜粠鏈嶅姟鍣ㄦ垨鏈湴瀛樺偍锛?
    async loadModelConfig() {
        try {
            console.log('馃攳 浠庢湇鍔″櫒鍔犺浇妯″瀷閰嶇疆...');

            // 灏濊瘯浠庢湰鍦版湇鍔″櫒鍔犺浇
            const response = await fetch(`${this.serverUrl}/api/config`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });

            if (response.ok) {
                const config = await response.json();
                console.log('馃摗 鏈嶅姟鍣ㄨ繑鍥為厤缃?', config);

                if (config.model) {
                    this.modelConfig.scale = parseFloat(config.model.scale) || 0.25;
                    this.modelConfig.x = parseFloat(config.model.x) || 0.3;
                    this.modelConfig.y = parseFloat(config.model.y) || 0.5;
                    this.mouthSpeed = parseInt(config.mouthSpeed) || 20;

                    // 淇濆瓨鍒版湰鍦板瓨鍌ㄤ綔涓哄浠?
                    this.saveConfigToLocalStorage(config);

                    // 鍔犺浇瀛楀箷瀛椾綋閰嶇疆
                    if (config.subtitle) {
                        this.baseFontSize = parseInt(config.subtitle.baseFontSize) || 36;
                        this.minFontSize = parseInt(config.subtitle.minFontSize) || 30;
                        this.fontScaleStep = parseFloat(config.subtitle.fontScaleStep) || 1.5;
                        this.charsPerLine = parseInt(config.subtitle.charsPerLine) || 0; // 0 琛ㄧず涓嶉檺鍒?
                        this.currentFontSize = this.baseFontSize;
                        console.log('馃敜 瀛楀箷瀛椾綋閰嶇疆:', config.subtitle);
                        this.applySubtitleFontConfig();
                    }

                    console.log('鉁?閰嶇疆鍔犺浇鎴愬姛:', this.modelConfig);
                    console.log('馃搷 灏嗗簲鐢ㄤ綅缃? X=' + this.modelConfig.x + ', Y=' + this.modelConfig.y + ', Scale=' + this.modelConfig.scale);
                    console.log('馃帳 鍢村瀷閫熷害:', this.mouthSpeed);
                    return true;
                } else {
                    throw new Error('鏈嶅姟鍣ㄦ湭杩斿洖妯″瀷閰嶇疆');
                }
            } else {
                throw new Error('鏈嶅姟鍣ㄥ搷搴旈敊璇? ' + response.status);
            }
        } catch (error) {
            console.warn('鈿狅笍 鏃犳硶浠庢湇鍔″櫒鍔犺浇閰嶇疆:', error.message);

            // 灏濊瘯浠庢湰鍦板瓨鍌ㄦ仮澶?
            const cachedConfig = this.loadConfigFromLocalStorage();
            if (cachedConfig && cachedConfig.model) {
                console.log('馃摝 浣跨敤鏈湴缂撳瓨閰嶇疆:', cachedConfig);
                this.modelConfig = {
                    scale: parseFloat(cachedConfig.model.scale) || 0.25,
                    x: parseFloat(cachedConfig.model.x) || 0.3,
                    y: parseFloat(cachedConfig.model.y) || 0.5
                };
                this.mouthSpeed = parseInt(cachedConfig.mouthSpeed) || 20;

                if (cachedConfig.subtitle) {
                    this.baseFontSize = parseInt(cachedConfig.subtitle.baseFontSize) || 36;
                    this.minFontSize = parseInt(cachedConfig.subtitle.minFontSize) || 30;
                    this.fontScaleStep = parseFloat(cachedConfig.subtitle.fontScaleStep) || 1.5;
                    this.currentFontSize = this.baseFontSize;
                }

                return true;
            }

            // 浣跨敤榛樿閰嶇疆
            console.log('馃搵 浣跨敤榛樿閰嶇疆');
            this.modelConfig = {
                scale: 0.25,
                x: 0.3,
                y: 0.5
            };
            this.mouthSpeed = 20;
            this.baseFontSize = 36;
            this.minFontSize = 30;
            this.fontScaleStep = 1.5;
            this.currentFontSize = this.baseFontSize;

            return true;
        }
    }

    // 淇濆瓨妯″瀷浣嶇疆鍒版湇鍔″櫒
    async saveModelPosition() {
        try {
            if (!this.model) return;

            // 鐩存帴淇濆瓨褰撳墠鍊硷紝涓嶅仛浠讳綍璁＄畻
            const newConfig = {
                scale: this.model.scale.x,
                x: this.model.x / window.innerWidth,
                y: this.model.y / window.innerHeight
            };

            console.log('馃捑 淇濆瓨閰嶇疆:', newConfig);

            // 淇濆瓨鍒版湇鍔″櫒
            try {
                const response = await fetch(`${this.serverUrl}/api/config/update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newConfig),
                    timeout: 5000
                });

                if (response.ok) {
                    const result = await response.json();
                    console.log('鉁?妯″瀷浣嶇疆宸蹭繚瀛樺埌鏈嶅姟鍣?', result);
                    // 鍚屾椂淇濆瓨鍒版湰鍦板瓨鍌?
                    this.saveConfigToLocalStorage({ model: newConfig });
                } else {
                    console.warn('Failed to save config to server (HTTP ' + response.status + '), saved to local cache only');
                    this.saveConfigToLocalStorage({ model: newConfig });
                }
            } catch (serverError) {
                console.warn('鈿狅笍 鏈嶅姟鍣ㄨ繛鎺ュけ璐ワ紝浠呬繚瀛樺埌鏈湴瀛樺偍:', serverError.message);
                this.saveConfigToLocalStorage({ model: newConfig });
            }
        } catch (error) {
            console.error('鉂?淇濆瓨妯″瀷浣嶇疆澶辫触:', error);
            // 鑷冲皯淇濆瓨鍒版湰鍦板瓨鍌?
            try {
                const newConfig = {
                    scale: this.model.scale.x,
                    x: this.model.x / window.innerWidth,
                    y: this.model.y / window.innerHeight
                };
                this.saveConfigToLocalStorage({ model: newConfig });
                console.log('馃捑 浣嶇疆宸蹭繚瀛樺埌鏈湴瀛樺偍');
            } catch (e) {
                console.error('鉂?鏈湴瀛樺偍淇濆瓨涔熷け璐?', e);
            }
        }
    }

    // 鏈湴瀛樺偍杈呭姪鍑芥暟 - 淇濆瓨閰嶇疆
    saveConfigToLocalStorage(config) {
        try {
            localStorage.setItem('live2d_model_config', JSON.stringify(config));
            console.log('馃捑 閰嶇疆宸蹭繚瀛樺埌鏈湴瀛樺偍');
        } catch (error) {
            console.warn('鈿狅笍 鏈湴瀛樺偍淇濆瓨澶辫触:', error);
        }
    }

    // 鏈湴瀛樺偍杈呭姪鍑芥暟 - 鍔犺浇閰嶇疆
    loadConfigFromLocalStorage() {
        try {
            const cached = localStorage.getItem('live2d_model_config');
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (error) {
            console.warn('鈿狅笍 鏈湴瀛樺偍璇诲彇澶辫触:', error);
        }
        return null;
    }

    async init() {
        try {
            // Initialize PIXI Application
            this.app = new PIXI.Application({
                view: document.getElementById('canvas'),
                autoStart: true,
                resizeTo: window,
                transparent: true,
                backgroundColor: 0x000000,
                backgroundAlpha: 0
            });

            // Load Live2D model
            await this.loadModel();

            // Setup subtitle display
            this.setupSubtitles();

            // Setup API communication
            this.setupApiCommunication();

            // Initialize emotion enhancer
            console.log('馃敡 鍒濆鍖栨儏缁寮哄櫒...');
            if (typeof EmotionEnhancer !== 'undefined') {
                this.emotionEnhancer = new EmotionEnhancer();
                console.log('鉁?鎯呯华澧炲己鍣ㄥ垵濮嬪寲鎴愬姛');
            } else {
                console.error('鉂?EmotionEnhancer绫绘湭鎵惧埌锛岃妫€鏌motion-enhancer.js鏄惁姝ｇ‘鍔犺浇');
            }

            console.log('Live2D Controller initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Live2D Controller:', error);
        }
    }




    async loadModel() {
        try {
            // Try to load model from models directory
            const modelUrl = './models/hiyori_pro_mic.model3.json';
            this.model = await PIXI.live2d.Live2DModel.from(modelUrl);

            if (this.model) {
                this.app.stage.addChild(this.model);
                await this.setupModelProperties(); // 绛夊緟閰嶇疆鍔犺浇瀹屾垚
                this.setupInteractivity();
                console.log('Live2D model loaded successfully');
            }
        } catch (error) {
            console.error('Failed to load Live2D model:', error);
            // Create placeholder if model fails to load
            this.createPlaceholder();
        }
    }

    createPlaceholder() {
        const graphics = new PIXI.Graphics();
        graphics.beginFill(0x4A90E2, 0.8);
        graphics.drawCircle(0, 0, 100);
        graphics.endFill();

        graphics.x = window.innerWidth * 0.8;
        graphics.y = window.innerHeight * 0.6;

        this.app.stage.addChild(graphics);
        console.log('Created placeholder for Live2D model');
    }

    async setupModelProperties() {
        if (!this.model) {
            console.error('Model is not loaded');
            return;
        }

        // 鍏堝姞杞介厤缃?
        await this.loadModelConfig();

        // 纭繚閰嶇疆鏈夋晥
        const scale = parseFloat(this.modelConfig.scale) || 0.8;
        const x = parseFloat(this.modelConfig.x) || 0.3;
        const y = parseFloat(this.modelConfig.y) || 0.5;

        console.log('馃帹 搴旂敤妯″瀷閰嶇疆: scale=' + scale + ', x=' + x + ', y=' + y);

        // 鐩存帴浣跨敤閰嶇疆鍊硷紝涓嶅仛浠讳綍澶嶆潅璁＄畻
        this.model.scale.set(scale, scale);
        this.model.x = window.innerWidth * x;
        this.model.y = window.innerHeight * y;

        // 纭繚妯″瀷鍙
        this.model.visible = true;
        this.model.alpha = 1.0;

        console.log('鉁?妯″瀷宸茶缃? scale=' + scale + ', x=' + this.model.x.toFixed(1) + 'px, y=' + this.model.y.toFixed(1) + 'px');

        // 绂佺敤鑷姩琛屼负锛堝ご閮ㄨ窡闅忛紶鏍囷級
        if (this.model.internalModel && this.model.tracker) {
            this.model.tracker.enabled = false;
            console.log('Head tracking disabled');
        }

        // 寤惰繜鍐嶆绂佺敤锛岀‘淇?tracker 宸茬粡鍒濆鍖?
        setTimeout(() => {
            if (this.model && this.model.internalModel && this.model.tracker) {
                this.model.tracker.enabled = false;
                console.log('鉁?寤惰繜绂佺敤澶撮儴璺熼殢榧犳爣锛堢‘淇濈敓鏁堬級');
            }
        }, 1000);
    }

    setupInteractivity() {
        if (!this.model) return;

        this.model.interactive = true;
        this.model.buttonMode = true;

        // 妯″瀷涓婄殑 mousedown 浜嬩欢 - 寮€濮嬫嫋鍔?
        this.model.on('mousedown', (e) => {
            this.isDragging = true;
            const point = e.data.global;
            this.dragOffset.x = point.x - this.model.x;
            this.dragOffset.y = point.y - this.model.y;

            // 瑙嗚鍙嶉锛氭敼鍙橀紶鏍囨牱寮忓拰閫忔槑搴?
            document.body.style.cursor = 'grabbing';
            this.model.alpha = 0.8;

            console.log('馃柋锔?寮€濮嬫嫋鍔ㄦā鍨嬶紝浣嶇疆:', { x: this.model.x, y: this.model.y });
        });

        // 鍏ㄥ眬 mousemove 浜嬩欢 - 鎷栧姩鏃舵洿鏂颁綅缃?
        // 娉ㄦ剰锛氫娇鐢ㄥ叏灞€浜嬩欢鑰屼笉鏄ā鍨嬩簨浠讹紝杩欐牱鍗充娇榧犳爣绉诲嚭妯″瀷鑼冨洿涔熻兘缁х画鎷栧姩
        const handleMouseMove = (e) => {
            if (this.isDragging && this.model) {
                const newX = e.clientX - this.dragOffset.x;
                const newY = e.clientY - this.dragOffset.y;

                // 搴旂敤杈圭晫妫€鏌?
                const boundedX = this.constrainPosition(newX, 'x');
                const boundedY = this.constrainPosition(newY, 'y');

                this.model.position.set(boundedX, boundedY);

                // 瀹炴椂鏄剧ず浣嶇疆鍙嶉
                this.showDragFeedback(boundedX, boundedY);
            }
        };

        // 鍏ㄥ眬 mouseup 浜嬩欢 - 缁撴潫鎷栧姩
        const handleMouseUp = async () => {
            if (this.isDragging) {
                this.isDragging = false;

                // 鎭㈠瑙嗚鏁堟灉
                document.body.style.cursor = 'default';
                this.model.alpha = 1.0;

                // 闅愯棌鎷栧姩鍙嶉
                this.hideDragFeedback();

                // 淇濆瓨鏂颁綅缃埌鏈嶅姟鍣?
                await this.saveModelPosition();

                console.log('鉁?鎷栧姩瀹屾垚锛屼綅缃凡淇濆瓨');
            }
        };

        // 娣诲姞浜嬩欢鐩戝惉鍣?
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        // Click for interaction - 鍙湪娌℃湁鎷栧姩鏃惰Е鍙?
        this.model.on('click', () => {
            if (!this.isDragging && this.model.internalModel) {
                this.model.motion("Tap");
                this.playRandomExpression();
                console.log('Model clicked');
            }
        });

        // 榧犳爣鎮仠鏁堟灉
        this.model.on('mouseover', () => {
            if (!this.isDragging) {
                document.body.style.cursor = 'grab';
            }
        });

        this.model.on('mouseout', () => {
            if (!this.isDragging) {
                document.body.style.cursor = 'default';
            }
        });
    }

    // 浣嶇疆绾︽潫鍑芥暟 - 闃叉妯″瀷琚嫋鍑哄睆骞?
    constrainPosition(value, axis) {
        // 鍏佽妯″瀷瓒呭嚭灞忓箷杈圭晫锛屾柟渚垮湪OBS涓皟鏁翠綅缃?
        // 璁剧疆鏇村鏉剧殑杈圭晫锛氬厑璁告ā鍨嬩腑蹇冪偣鍦ㄥ睆骞曞寰堣繙鐨勫湴鏂?
        const modelSize = 2000; // 鍋囪妯″瀷鏈€澶у昂瀵?

        if (axis === 'x') {
            const minX = -modelSize;
            const maxX = window.innerWidth + modelSize;
            return Math.max(minX, Math.min(maxX, value));
        } else if (axis === 'y') {
            const minY = -modelSize;
            const maxY = window.innerHeight + modelSize;
            return Math.max(minY, Math.min(maxY, value));
        }

        return value;
    }

    // 鏄剧ず鎷栧姩鍙嶉 - 瀹炴椂鏄剧ず浣嶇疆淇℃伅
    showDragFeedback(x, y) {
        if (!this.dragFeedbackElement) {
            this.dragFeedbackElement = document.createElement('div');
            this.dragFeedbackElement.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                color: #00ff00;
                padding: 10px 15px;
                border-radius: 5px;
                font-family: monospace;
                font-size: 12px;
                z-index: 9999;
                pointer-events: none;
                border: 1px solid #00ff00;
            `;
            document.body.appendChild(this.dragFeedbackElement);
        }

        const relX = (x / window.innerWidth * 100).toFixed(1);
        const relY = (y / window.innerHeight * 100).toFixed(1);

        this.dragFeedbackElement.textContent = `馃搷 X: ${relX}% Y: ${relY}%`;
        this.dragFeedbackElement.style.display = 'block';
    }

    // 闅愯棌鎷栧姩鍙嶉
    hideDragFeedback() {
        if (this.dragFeedbackElement) {
            this.dragFeedbackElement.style.display = 'none';
        }
    }

    setupSubtitles() {
        this.subtitleElement = document.getElementById('subtitle-text');
        this.subtitleContainer = document.getElementById('subtitle-container');
        this.subtitleTimeout = null;

        // 瀛椾綋缂╂斁鐩稿叧锛堝皢浠庨厤缃姞杞斤級
        this.baseFontSize = 36; // 鍩虹瀛椾綋澶у皬锛堥粯璁ゅ€硷級
        this.minFontSize = 30;  // 鏈€灏忓瓧浣撳ぇ灏忥紙榛樿鍊硷級
        this.fontScaleStep = 1.5; // 姣忔鎹㈣缂╁皬鐨勫儚绱狅紙榛樿鍊硷級
        this.currentFontSize = this.baseFontSize;

        if (!this.subtitleElement || !this.subtitleContainer) {
            console.error('Subtitle elements not found');
        } else {
            // 鍒濆鍖栧瓧浣撳ぇ灏?
            this.subtitleElement.style.fontSize = this.baseFontSize + 'px';
        }
    }

    // 搴旂敤瀛椾綋閰嶇疆锛堝湪閰嶇疆鍔犺浇鍚庤皟鐢級
    applySubtitleFontConfig() {
        if (this.subtitleElement) {
            this.currentFontSize = this.baseFontSize;
            this.subtitleElement.style.fontSize = this.baseFontSize + 'px';
            console.log('鉁?瀛楀箷瀛椾綋宸插簲鐢? ' + this.baseFontSize + 'px');
        }
    }

    setupApiCommunication() {
        // Setup high-frequency subtitle polling for lower latency
        setInterval(() => {
            this.pollForUpdates();
        }, 200); // Check every 200ms for subtitle updates (faster)

        // Setup periodic health check
        setInterval(() => {
            this.connectToMemoryUniverse();
        }, 5000);
    }

    async connectToMemoryUniverse() {
        // Use Web Manager health endpoint for service status check
        // Primary signal is the memory-universe service health from manager orchestration
        const isProxyOrigin = window.location.port === '' || window.location.port === '80' || window.location.port === '443' || window.location.port === '8080';
        const defaultManagerUrl = isProxyOrigin
            ? window.location.origin
            : `${window.location.protocol}//${window.location.hostname}:8080`;
        const WEB_MANAGER_URL = window.MEMORY_SUITE_MANAGER_URL || defaultManagerUrl;

        try {
            const response = await fetch(`${WEB_MANAGER_URL}/api/services/memory-universe/health`, {
                timeout: 3000
            });

            if (response.ok) {
                const data = await response.json();
                if (data.success && data.status === 'healthy') {
                    // Services are healthy, poll for updates
                    this.pollForUpdates();

                    // Log connection status periodically (every 30 seconds)
                    if (!this._lastHealthLog || Date.now() - this._lastHealthLog > 30000) {
                        console.log('鉁?Memory Universe services connected via Web Manager');
                        this._lastHealthLog = Date.now();
                    }
                } else {
                    // Services degraded but still responding
                    console.warn('鈿狅笍 Memory Universe services degraded:', data.status);
                    this.pollForUpdates(); // Still try to poll
                }
            } else {
                // Web Manager responded but with error status
                console.warn('鈿狅笍 Web Manager health check failed:', response.status);
            }
        } catch (error) {
            // Web Manager unavailable, fallback to direct Memory Universe health check
            try {
                const fallbackMuUrl = window.MEMORY_UNIVERSE_URL || `${window.location.protocol}//${window.location.hostname}:4005`;
                const fallbackResponse = await fetch(`${fallbackMuUrl}/health`, {
                    timeout: 2000
                });
                if (fallbackResponse.ok) {
                    console.log('馃攧 Using fallback direct connection to Memory Universe');
                    this.pollForUpdates();
                }
            } catch (fallbackError) {
                // All services unavailable, continue silently
                // This is expected during startup or when services are down
            }
        }
    }

    async pollForUpdates() {
        try {
            // Check for new audio/subtitle updates
            const response = await fetch(`${this.serverUrl}/api/audio/current`);
            if (response.ok) {
                const data = await response.json();

                // 鏇存柊瀛楀箷鏄剧ず锛堟墦瀛楁満鏁堟灉锛?
                if (data.subtitle !== undefined && data.subtitle !== this.lastSubtitle) {
                    const oldSubtitle = this.lastSubtitle || '';
                    this.lastSubtitle = data.subtitle;

                    if (this.subtitleElement) {
                        // 濡傛灉鏂板瓧骞曟槸鍦ㄦ棫瀛楀箷鍩虹涓婄疮绉殑锛屽彧鎵撳瓧鏂板閮ㄥ垎
                        if (data.subtitle && data.subtitle.startsWith(oldSubtitle) && oldSubtitle.length > 0) {
                            const newPart = data.subtitle.substring(oldSubtitle.length);
                            this.typewriterAppend(newPart);
                        } else if (data.subtitle) {
                            // 鍏ㄦ柊鐨勫瓧骞曪紝浠庡ご寮€濮嬫墦瀛?
                            this.typewriterShow(data.subtitle);
                        } else {
                            // 娓呯┖瀛楀箷
                            this.clearSubtitle();
                        }
                        console.log('馃摵 瀛楀箷鏇存柊:', data.subtitle || '(娓呯┖)');

                        // 馃敡 淇锛氬鏋滄湁 duration锛岃缃嚜鍔ㄦ竻闄ゅ畾鏃跺櫒
                        if (data.subtitleDuration && data.subtitleDuration > 0 && data.subtitle) {
                            this.scheduleSubtitleClear(data.subtitleDuration);
                        }
                    }
                }

                // Check for new audio to play
                if (data.audio && data.audio.timestamp !== this.lastAudioTimestamp) {
                    console.log('馃攰 New audio received:', data.audio);
                    this.lastAudioTimestamp = data.audio.timestamp;

                    // 鎾斁闊抽骞跺悓姝ュ槾鍨?
                    if (data.audio.audioPath) {
                        this.playAudioWithMouth(data.audio);
                    }

                    // 鏍规嵁鏂囨湰妫€娴嬪苟搴旂敤琛ㄦ儏
                    if (this.emotionEnhancer && data.audio.text) {
                        const emotion = this.emotionEnhancer.detectEmotionFromText(data.audio.text);
                        this.emotionEnhancer.applyEmotion(emotion, this.model, true); // skipMouth=true锛屽槾鍨嬬敱闊抽鎺у埗
                    }
                }
            }
        } catch (error) {
            // Silently ignore polling errors
        }
    }

    // 鎸夋瘡琛屾渶澶у瓧鏁版彃鍏ユ崲琛?
    wrapText(text) {
        if (!this.charsPerLine || this.charsPerLine <= 0) return text;

        const lines = [];
        let currentLine = '';

        for (const char of text) {
            if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
                continue;
            }

            currentLine += char;

            if (currentLine.length >= this.charsPerLine) {
                lines.push(currentLine);
                currentLine = '';
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines.join('\n');
    }

    // 鎵撳瓧鏈烘晥鏋?- 鏄剧ず鏂板瓧骞?
    typewriterShow(text) {
        // 鍋滄涔嬪墠鐨勬墦瀛楀姩鐢?
        if (this.typingTimer) {
            clearInterval(this.typingTimer);
            this.typingTimer = null;
        }

        if (this.subtitleContainer) {
            this.subtitleContainer.style.display = 'block';
        }

        // 鎸夊瓧鏁版崲琛?
        const wrappedText = this.wrapText(text);

        let index = 0;
        this.subtitleElement.textContent = '';

        this.typingTimer = setInterval(() => {
            if (index < wrappedText.length) {
                this.subtitleElement.textContent += wrappedText[index];
                index++;
            } else {
                clearInterval(this.typingTimer);
                this.typingTimer = null;
            }
        }, 50); // 姣忎釜瀛?50ms
    }

    // 鎵撳瓧鏈烘晥鏋?- 杩藉姞鏂板唴瀹?
    typewriterAppend(newText) {
        if (!newText) return;

        // 鍋滄涔嬪墠鐨勬墦瀛楀姩鐢?
        if (this.typingTimer) {
            clearInterval(this.typingTimer);
            this.typingTimer = null;
        }

        if (this.subtitleContainer) {
            this.subtitleContainer.style.display = 'block';
        }

        let index = 0;
        const fullText = this.lastSubtitle; // 瀹屾暣鏂囨湰

        this.typingTimer = setInterval(() => {
            if (index < newText.length) {
                // 閫愬瓧鏄剧ず锛屼娇鐢ㄦ崲琛屽悗鐨勬枃鏈?
                const partialFull = fullText.substring(0, fullText.length - newText.length + index + 1);
                this.subtitleElement.textContent = this.wrapText(partialFull);
                index++;
            } else {
                clearInterval(this.typingTimer);
                this.typingTimer = null;
            }
        }, 50); // 姣忎釜瀛?50ms
    }

    // 娓呯┖瀛楀箷
    clearSubtitle() {
        if (this.typingTimer) {
            clearInterval(this.typingTimer);
            this.typingTimer = null;
        }
        if (this.subtitleClearTimer) {
            clearTimeout(this.subtitleClearTimer);
            this.subtitleClearTimer = null;
        }
        if (this.subtitleElement) {
            this.subtitleElement.textContent = '';
        }
        if (this.subtitleContainer) {
            this.subtitleContainer.style.display = 'none';
        }
        // 鍚屾娓呯┖ lastSubtitle锛岄伩鍏嶄笅娆¤疆璇㈡椂璇垽
        this.lastSubtitle = '';
    }

    // 馃啎 瀹氭椂娓呴櫎瀛楀箷锛堢敤浜庝富鍔ㄥ彂瑷€绛夊満鏅級
    scheduleSubtitleClear(durationMs) {
        // 娓呴櫎涔嬪墠鐨勫畾鏃跺櫒
        if (this.subtitleClearTimer) {
            clearTimeout(this.subtitleClearTimer);
        }

        console.log(`Subtitle will be cleared in ${durationMs}ms`);

        this.subtitleClearTimer = setTimeout(async () => {
            console.log('馃Ч 鑷姩娓呴櫎瀛楀箷');
            this.clearSubtitle();

            // 鍚屾椂閫氱煡鏈嶅姟绔竻闄ゅ瓧骞曠姸鎬?
            try {
                await fetch(`${this.serverUrl}/api/subtitle/clear`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) {
                // 蹇界暐閿欒
            }
        }, durationMs);
    }

    // 鎾斁闊抽骞跺悓姝ュ槾鍨?
    async playAudioWithMouth(audioInfo) {
        if (!audioInfo || !audioInfo.audioPath) return;

        try {
            const audio = new Audio(audioInfo.audioPath);
            this.currentAudio = audio;
            const duration = (audioInfo.duration || 2) * 1000; // 杞崲涓烘绉?

            // 寮€濮嬫挱鏀炬椂鍚姩鍢村瀷鍔ㄧ敾
            audio.onplay = () => {
                console.log('Audio playback started');
                // 浣跨敤 emotionEnhancer 鐨勫槾鍨嬪姩鐢?
                if (this.emotionEnhancer) {
                    this.emotionEnhancer.startMouthSyncWithAudio(this.model, duration, this.mouthSpeed);
                } else {
                    this.startMouthAnimation(duration / 1000);
                }
            };

            audio.onended = () => {
                console.log('馃幍 闊抽鎾斁瀹屾垚');
                if (this.emotionEnhancer) {
                    this.emotionEnhancer.stopMouthSync(this.model);
                } else {
                    this.stopMouthAnimation();
                }

                // 馃啎 闊抽鎾斁瀹屾垚鍚庯紝寤惰繜娓呴櫎瀛楀箷锛堢粰鐢ㄦ埛涓€鐐归槄璇绘椂闂达級
                setTimeout(() => {
                    // 鍙湁褰撳瓧骞曞唴瀹逛笌褰撳墠闊抽鏂囨湰鍖归厤鏃舵墠娓呴櫎
                    if (this.lastSubtitle && audioInfo.text && this.lastSubtitle === audioInfo.text) {
                        console.log('Audio playback ended, clearing subtitle');
                        this.clearSubtitle();
                        // 閫氱煡鏈嶅姟绔?
                        fetch(`${this.serverUrl}/api/subtitle/clear`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        }).catch(() => { });
                    }
                }, 1000); // 寤惰繜1绉掓竻闄?
            };

            audio.onerror = (e) => {
                console.error('鉂?闊抽鎾斁澶辫触:', e);
                if (this.emotionEnhancer) {
                    this.emotionEnhancer.stopMouthSync(this.model);
                } else {
                    this.stopMouthAnimation();
                }
            };

            // Enhanced playback with autoplay handling
            audio.play().catch(async (e) => {
                console.warn('⚠️ Autoplay prevented:', e);
                // Try resuming AudioContext if using PIXI
                if (window.PIXI && PIXI.sound && PIXI.sound.context) {
                    if (PIXI.sound.context.audioContext.state === 'suspended') {
                        await PIXI.sound.context.audioContext.resume();
                        audio.play().catch(err => console.error('Retry failed:', err));
                    }
                }
            });
        } catch (error) {
            console.error('鉂?鎾斁闊抽澶辫触:', error);
        }
    }

    // 澶囩敤鍢村瀷鍔ㄧ敾锛堝綋 emotionEnhancer 涓嶅彲鐢ㄦ椂锛?
    startMouthAnimation(duration) {
        if (this.mouthAnimationInterval) {
            clearInterval(this.mouthAnimationInterval);
        }

        let phase = 0;
        this.mouthAnimationInterval = setInterval(() => {
            const value = Math.sin(phase) * 0.5 + 0.5;
            this.setMouthOpenY(value);
            phase += 0.3;
        }, 50);

        setTimeout(() => {
            this.stopMouthAnimation();
        }, duration * 1000);
    }

    stopMouthAnimation() {
        if (this.mouthAnimationInterval) {
            clearInterval(this.mouthAnimationInterval);
            this.mouthAnimationInterval = null;
        }
        this.setMouthOpenY(0);
    }

    // Mouth animation for speech
    setMouthOpenY(value) {
        if (!this.model || !this.model.internalModel) return;

        try {
            value = Math.max(0, Math.min(value, 3.0));
            const coreModel = this.model.internalModel.coreModel;

            // Try different parameter names
            try {
                coreModel.setParameterValueById('PARAM_MOUTH_OPEN_Y', value);
            } catch (e) {
                try {
                    coreModel.setParameterValueById('ParamMouthOpenY', value);
                } catch (e2) {
                    // Ignore if parameter doesn't exist
                }
            }
        } catch (error) {
            console.error('Failed to set mouth animation:', error);
        }
    }

    maybeTriggerSpin(text) {
        if (!text) return;
        const now = Date.now();
        if (now - this.lastSpinTime < this.spinCooldownMs) return;
        if (text === this.lastSpinText) return;

        const hit = this.spinKeywords.some(keyword => text.includes(keyword));
        if (!hit) return;

        this.lastSpinTime = now;
        this.lastSpinText = text;
        this.triggerSpin();
    }

    triggerSpin(durationMs = 1200) {
        if (!this.model || this.isSpinning) return;

        this.isSpinning = true;
        const baseScaleX = this.model.scale.x;
        const baseSkewY = this.model.skew.y || 0;
        const start = performance.now();

        const animate = (time) => {
            const elapsed = time - start;
            const t = Math.min(elapsed / durationMs, 1);
            const angle = t * Math.PI * 2;
            const scaleX = Math.cos(angle);

            this.model.scale.x = baseScaleX * scaleX;
            this.model.skew.y = baseSkewY + Math.sin(angle) * 0.1;

            if (t < 1) {
                this.spinAnimationId = requestAnimationFrame(animate);
            } else {
                this.model.scale.x = baseScaleX;
                this.model.skew.y = baseSkewY;
                this.isSpinning = false;
                this.spinAnimationId = null;
            }
        };

        this.spinAnimationId = requestAnimationFrame(animate);
    }
}

// Initialize when page loads
window.addEventListener('DOMContentLoaded', async () => {
    const controller = new Live2DController();
    await controller.init();

    // Make controller globally available
    window.live2dController = controller;

    // Add keyboard controls
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === ' ') {
            controller.stopPlayback();
        }
    });
});

