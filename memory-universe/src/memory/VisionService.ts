/**
 * Vision Service - 视觉理解服务
 * 
 * 使用 Qwen3-VL-4B GGUF 进行图像理解
 * 复用项目已有的 node-llama-cpp
 * 
 * 硬件约束: RTX 2070 Super 8GB
 * - Qwen3-VL-4B Q4_K_M + mmproj: ~3GB VRAM
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

const CONFIG = {
    enabled: process.env.VISION_ENABLED === 'true',
    modelPath: process.env.VISION_MODEL_PATH || '',
    mmprojPath: process.env.VISION_MMPROJ_PATH || '',
    useGpu: process.env.VISION_USE_GPU !== 'false',
    gpuLayers: parseInt(process.env.VISION_GPU_LAYERS || '0', 10) || -1,
    contextSize: parseInt(process.env.VISION_CONTEXT_SIZE || '2048', 10),
    maxImageSize: parseInt(process.env.VISION_MAX_IMAGE_SIZE || '1280', 10),
    captureInterval: parseInt(process.env.VISION_CAPTURE_INTERVAL || '5000', 10),
    cacheDir: process.env.VISION_CACHE_DIR || path.resolve(process.cwd(), 'data/vision_cache'),
};

export interface VisionResult {
    description: string;
    objects: string[];
    scene: string;
    confidence: number;
    timestamp: string;
    imageHash?: string;
}

export interface SceneChange {
    previousScene: string;
    currentScene: string;
    changed: boolean;
    changeDescription?: string;
}

export class VisionService {
    private initialized: boolean = false;
    private modelLoaded: boolean = false;
    private llama: any = null;
    private model: any = null;
    private context: any = null;
    private lastCapture: Buffer | null = null;
    private lastResult: VisionResult | null = null;
    private captureInterval: NodeJS.Timeout | null = null;
    private logger: (...args: any[]) => void;
    private tempImagePath: string;

    constructor(logger?: (...args: any[]) => void) {
        this.logger = logger || console.log;
        this.tempImagePath = path.join(CONFIG.cacheDir, 'temp_capture.png');
    }

    async initialize(): Promise<boolean> {
        if (!CONFIG.enabled) {
            this.logger('[Vision] Vision service disabled by config');
            return false;
        }

        if (!CONFIG.modelPath || !fs.existsSync(CONFIG.modelPath)) {
            this.logger('[Vision] Model path not found:', CONFIG.modelPath);
            this.logger('[Vision] Running in mock mode');
            this.initialized = true;
            return true;
        }

        if (!CONFIG.mmprojPath || !fs.existsSync(CONFIG.mmprojPath)) {
            this.logger('[Vision] mmproj path not found:', CONFIG.mmprojPath);
            this.logger('[Vision] Running in mock mode');
            this.initialized = true;
            return true;
        }

        try {
            this.logger('[Vision] Initializing vision service...');
            this.logger(`[Vision] Model: ${CONFIG.modelPath}`);
            this.logger(`[Vision] mmproj: ${CONFIG.mmprojPath}`);
            
            if (!fs.existsSync(CONFIG.cacheDir)) {
                fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
            }

            try {
                const { getLlama } = await import('node-llama-cpp');
                
                this.llama = await getLlama({
                    gpu: CONFIG.useGpu ? 'auto' : false,
                });

                this.model = await this.llama.loadModel({
                    modelPath: CONFIG.modelPath,
                    mmproj: {
                        modelPath: CONFIG.mmprojPath,
                    },
                });

                this.context = await this.model.createContext({
                    contextSize: CONFIG.contextSize,
                });

                this.modelLoaded = true;
                this.logger('[Vision] Vision model loaded successfully');
            } catch (loadErr) {
                this.logger('[Vision] Model load failed, running in mock mode:', loadErr);
                this.modelLoaded = false;
            }

            this.initialized = true;
            return true;
        } catch (err) {
            this.logger('[Vision] Initialization failed:', err);
            this.initialized = true;
            return true;
        }
    }

    async captureScreen(): Promise<Buffer> {
        try {
            if (!fs.existsSync(CONFIG.cacheDir)) {
                fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
            }

            if (process.platform === 'win32') {
                const tempPath = this.tempImagePath;
                
                // 方法1: 使用 PowerShell Graphics.CopyFromScreen (静默后台截图，无弹窗)
                try {
                    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$point = New-Object System.Drawing.Point(0, 0)
$graphics.CopyFromScreen($bounds.Location, $point, $bounds.Size)
$bitmap.Save('${tempPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output 'success'
`.replace(/\n/g, ' ');
                    
                    await execAsync(
                        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -command "${psScript}"`,
                        { timeout: 10000 }
                    );
                    
                    if (fs.existsSync(tempPath)) {
                        const buffer = fs.readFileSync(tempPath);
                        this.lastCapture = buffer;
                        return buffer;
                    }
                } catch (psErr) {
                    this.logger('[Vision] PowerShell capture failed:', psErr);
                }
                
                // 方法2: 使用 nircmd (如果安装了，完全静默)
                try {
                    const nircmdPath = 'nircmd';
                    await execAsync(`${nircmdPath} savescreenshotfull "${tempPath}"`, { timeout: 5000 });
                    if (fs.existsSync(tempPath)) {
                        const buffer = fs.readFileSync(tempPath);
                        this.lastCapture = buffer;
                        return buffer;
                    }
                } catch (nircmdErr) {
                    // nircmd 不可用，忽略
                }
                
                // 方法3: 使用 Windows 内置工具 (Win10+)
                try {
                    const snippingTool = 'ms-screenclip';
                    // 这个会弹窗，跳过
                } catch {
                    // 忽略
                }
            }
            
            throw new Error('Screen capture not available');
        } catch (err) {
            this.logger('[Vision] Screen capture failed:', err);
            throw err;
        }
    }

    async analyzeImage(imageBuffer: Buffer): Promise<VisionResult> {
        const hash = this.hashImage(imageBuffer);
        
        if (this.lastResult && this.lastResult.imageHash === hash) {
            return this.lastResult;
        }

        if (!this.modelLoaded || !this.context) {
            return this.getMockResult(hash);
        }

        try {
            const tempPath = path.join(CONFIG.cacheDir, `analyze_${Date.now()}.png`);
            fs.writeFileSync(tempPath, imageBuffer);

            const prompt = '描述这张图片的内容，包括场景、物体和活动。';
            
            let description = '';
            
            try {
                const session = await this.context.createChatSession();
                
                const response = await session.prompt([
                    {
                        type: 'image',
                        image: tempPath,
                    },
                    {
                        type: 'text',
                        text: prompt,
                    },
                ], {
                    maxTokens: 256,
                    temperature: 0.7,
                });
                
                description = response;
            } catch (promptErr) {
                this.logger('[Vision] Prompt failed:', promptErr);
                description = '图像分析失败';
            }
            
            fs.unlinkSync(tempPath);

            const visionResult: VisionResult = {
                description,
                objects: this.extractObjects(description),
                scene: this.extractScene(description),
                confidence: 0.85,
                timestamp: new Date().toISOString(),
                imageHash: hash,
            };

            this.lastResult = visionResult;
            return visionResult;
        } catch (err) {
            this.logger('[Vision] Image analysis failed:', err);
            return this.getMockResult(hash);
        }
    }

    private extractObjects(description: string): string[] {
        const objects: string[] = [];
        const patterns = [
            /有([一二三四五六七八九十\d]+)个?([^，。！？、]+)/g,
            /看到([一二三四五六七八九十\d]+)个?([^，。！？、]+)/g,
            /包含([^，。！？、]+)/g,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(description)) !== null) {
                const obj = match[match.length - 1].trim();
                if (obj.length > 1 && obj.length < 10) {
                    objects.push(obj);
                }
            }
        }

        return [...new Set(objects)].slice(0, 5);
    }

    private extractScene(description: string): string {
        const sceneKeywords = [
            { keywords: ['游戏', '界面', '菜单', '角色'], scene: 'game' },
            { keywords: ['桌面', '电脑', '窗口'], scene: 'desktop' },
            { keywords: ['视频', '播放', '电影'], scene: 'video' },
            { keywords: ['聊天', '对话', '消息'], scene: 'chat' },
        ];

        for (const { keywords, scene } of sceneKeywords) {
            if (keywords.some(kw => description.includes(kw))) {
                return scene;
            }
        }

        return 'unknown';
    }

    private getMockResult(hash?: string): VisionResult {
        return {
            description: '视觉模型未加载，请检查配置',
            objects: [],
            scene: 'unknown',
            confidence: 0,
            timestamp: new Date().toISOString(),
            imageHash: hash,
        };
    }

    private hashImage(buffer: Buffer): string {
        let hash = 0;
        const sampleSize = Math.min(buffer.length, 1000);
        for (let i = 0; i < sampleSize; i++) {
            hash = ((hash << 5) - hash) + buffer[i];
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    async detectSceneChange(currentBuffer: Buffer): Promise<SceneChange> {
        if (!this.lastCapture) {
            return {
                previousScene: 'none',
                currentScene: 'initial',
                changed: true,
            };
        }

        const currentHash = this.hashImage(currentBuffer);
        const previousHash = this.hashImage(this.lastCapture);
        
        const changed = currentHash !== previousHash;
        
        return {
            previousScene: previousHash,
            currentScene: currentHash,
            changed,
            changeDescription: changed ? '场景发生变化' : undefined,
        };
    }

    needsVisionContext(input: string): boolean {
        const visionKeywords = [
            '看到', '看', '画面', '屏幕', '显示', '是什么',
            '这个', '那个', '这里', '那里', '现在',
            '游戏', '直播', '画面里', '图片', '图像',
            '识别', '认出', '描述', '分析',
        ];
        
        return visionKeywords.some(kw => input.includes(kw));
    }

    formatForPrompt(result: VisionResult): string {
        const lines = [
            '## 当前画面',
            `描述: ${result.description}`,
        ];
        
        if (result.objects.length > 0) {
            lines.push(`物体: ${result.objects.join(', ')}`);
        }
        
        if (result.scene !== 'unknown') {
            lines.push(`场景: ${result.scene}`);
        }
        
        return lines.join('\n');
    }

    startPeriodicCapture(callback?: (result: VisionResult) => void): void {
        if (this.captureInterval) {
            this.logger('[Vision] Periodic capture already running');
            return;
        }

        this.captureInterval = setInterval(async () => {
            try {
                const buffer = await this.captureScreen();
                const result = await this.analyzeImage(buffer);
                callback?.(result);
            } catch (err) {
                this.logger('[Vision] Periodic capture error:', err);
            }
        }, CONFIG.captureInterval);

        this.logger(`[Vision] Started periodic capture (interval: ${CONFIG.captureInterval}ms)`);
    }

    stopPeriodicCapture(): void {
        if (this.captureInterval) {
            clearInterval(this.captureInterval);
            this.captureInterval = null;
            this.logger('[Vision] Stopped periodic capture');
        }
    }

    async dispose(): Promise<void> {
        this.stopPeriodicCapture();
        
        if (this.context) {
            try {
                await this.context.dispose();
            } catch (err) {
                this.logger('[Vision] Context dispose error:', err);
            }
            this.context = null;
        }
        
        if (this.model) {
            try {
                await this.model.dispose();
            } catch (err) {
                this.logger('[Vision] Model dispose error:', err);
            }
            this.model = null;
        }
        
        this.modelLoaded = false;
        this.logger('[Vision] Service disposed');
    }

    getStatus(): {
        enabled: boolean;
        initialized: boolean;
        modelLoaded: boolean;
        lastCapture: string | null;
        captureRunning: boolean;
        config: {
            modelPath: string;
            mmprojPath: string;
            useGpu: boolean;
            contextSize: number;
        };
    } {
        return {
            enabled: CONFIG.enabled,
            initialized: this.initialized,
            modelLoaded: this.modelLoaded,
            lastCapture: this.lastResult?.timestamp || null,
            captureRunning: this.captureInterval !== null,
            config: {
                modelPath: CONFIG.modelPath,
                mmprojPath: CONFIG.mmprojPath,
                useGpu: CONFIG.useGpu,
                contextSize: CONFIG.contextSize,
            },
        };
    }
}

let instance: VisionService | null = null;

export function getVisionService(logger?: (...args: any[]) => void): VisionService {
    if (!instance) {
        instance = new VisionService(logger);
    }
    return instance;
}
