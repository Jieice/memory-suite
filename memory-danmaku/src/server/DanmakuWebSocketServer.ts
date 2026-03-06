// 弹幕WebSocket服务器 - 推送弹幕到显示页面
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';

export interface DanmakuData {
  username: string;
  message: string;
  type: string;
}

export interface StatusData {
  type: 'status';
  status: string;
  extra: string;
  timestamp: number;
}

export class DanmakuWebSocketServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private wsClients: Set<WebSocket> = new Set();
  
  constructor(
    private port: number,
    private logger: (...args: any[]) => void
  ) {
    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.setupWebSocket();
  }
  
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 健康检查端点
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'memory-danmaku',
        uptime: process.uptime(),
        timestamp: Date.now(),
        details: {
          connectedClients: this.wsClients.size
        }
      }));
      return;
    }
    
    const validRoutes: Record<string, string> = {
      '/': 'danmaku-overlay.html',
      '/danmaku': 'danmaku-overlay.html',
      '/danmaku-overlay.html': 'danmaku-overlay.html',
      '/test-danmaku.html': 'test-danmaku.html',
      '/status': 'ai-status.html',
      '/ai-status.html': 'ai-status.html',
      '/ambient': 'ambient-animation.html',
      '/ambient-animation.html': 'ambient-animation.html'
    };
    
    const fileName = validRoutes[req.url || ''];
    
    if (fileName) {
      const htmlPath = path.join(process.cwd(), fileName);
      fs.readFile(htmlPath, 'utf8', (err, data) => {
        if (err) {
          this.logger('读取文件失败:', htmlPath, err.message);
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
  
  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.logger('✅ 弹幕显示页面已连接');
      this.wsClients.add(ws);
      
      ws.on('close', () => {
        this.wsClients.delete(ws);
        this.logger('❌ 弹幕显示页面已断开');
      });
      
      ws.on('error', (err) => {
        this.logger('WebSocket错误:', err.message);
      });
    });
  }
  
  broadcastDanmaku(data: DanmakuData): void {
    if (this.wsClients.size === 0) return;
    
    const message = JSON.stringify(data);
    this.wsClients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
    this.logger(`📤 广播弹幕: [${data.username}] ${data.message} (${data.type})`);
  }
  
  broadcastStatus(status: string, extra: string = ''): void {
    if (this.wsClients.size === 0) return;
    
    const message = JSON.stringify({
      type: 'status',
      status,
      extra,
      timestamp: Date.now()
    });
    
    this.wsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }
  
  listen(): void {
    this.httpServer.listen(this.port, () => {
      this.logger('=================================');
      this.logger(`✅ 弹幕显示服务已启动`);
      this.logger(`📺 弹幕显示: http://localhost:${this.port}/danmaku-overlay.html`);
      this.logger(`🤖 AI状态: http://localhost:${this.port}/ai-status.html`);
      this.logger(`✨ 环境动画: http://localhost:${this.port}/ambient-animation.html`);
      this.logger(`🧪 测试页面: http://localhost:${this.port}/test-danmaku.html`);
      this.logger('=================================');
    });
  }
}
