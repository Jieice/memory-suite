// B站直播间连接器 - 负责获取弹幕信息和连接
import https from 'https';
// @ts-ignore - danmaku-headers.js is a JavaScript file
import { createDanmakuHeaders, resolveDanmakuQuery, autoFetchSignature } from '../../danmaku-headers.js';

export interface DanmuInfo {
  code: number;
  data?: {
    token: string;
    host_list: Array<{ host: string; port: number; wss_port: number }>;
    live_status?: number;
    uid?: number;
  };
  message?: string;
}

export interface RoomInfo {
  roomId: number;
  live_status: number;
}

export class BilibiliConnector {
  constructor(
    private cookie: string,
    private danmakuType: number,
    private webLocation: string,
    private fixedWRid?: string,
    private fixedWts?: number,
    private logger: (...args: any[]) => void = console.log
  ) {}
  
  async getRoomInit(roomId: number): Promise<RoomInfo> {
    return new Promise((resolve) => {
      const url = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`;
      https
        .get(url, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const realId = json.data?.room_id || roomId;
              this.logger('房间ID转换:', roomId, '->', realId);
              resolve({
                roomId: realId,
                live_status: json.data?.live_status ?? 0
              });
            } catch {
              resolve({ roomId, live_status: 0 });
            }
          });
        })
        .on('error', () => resolve({ roomId, live_status: 0 }));
    });
  }
  
  async fetchDanmuInfo(roomId: number): Promise<DanmuInfo> {
    // 检查Cookie有效性
    try {
      this.logger('检查 Cookie 有效性...');
      const testResp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          'Cookie': this.cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (testResp.ok) {
        const navData: any = await testResp.json();
        if (navData.code === 0 && navData.data?.isLogin) {
          this.logger('Cookie 有效，用户已登录:', navData.data.uname);
        } else {
          this.logger('Cookie 可能已过期');
        }
      }
    } catch (err: any) {
      this.logger('Cookie 检查失败:', err.message);
    }
    
    const defaultHeaders = {
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: this.cookie,
      Origin: 'https://live.bilibili.com',
      Referer: `https://live.bilibili.com/${roomId}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    
    const tryOnce = async ({ wRid, wts, label }: { wRid: string; wts: number; label: string }): Promise<DanmuInfo> => {
      const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=${this.danmakuType}&web_location=${this.webLocation}&w_rid=${wRid}&wts=${wts}`;
      const headers = {
        ...defaultHeaders,
        ...createDanmakuHeaders(roomId, this.cookie)
      };
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`getDanmuInfo 返回 ${resp.status} (${label})`);
      const data: any = await resp.json();
      this.logger('getDanmuInfo', {
        label,
        code: data.code,
        message: data.message,
        live_status: data.data?.live_status,
        token: data.data?.token ? 'ready' : 'missing'
      });
      return data as DanmuInfo;
    };
    
    // 尝试固定签名
    if (this.fixedWRid && this.fixedWts) {
      const data = await tryOnce({ wRid: this.fixedWRid, wts: this.fixedWts, label: 'fixed' });
      if (data.code === 0) return data;
      this.logger('固定 wRid/wts 失败，改用动态生成');
    }
    
    // 尝试备用API
    try {
      this.logger('尝试备用API端点...');
      const alternativeUrl = `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`;
      const altResp = await fetch(alternativeUrl, { 
        headers: defaultHeaders
      });
      
      if (altResp.ok) {
        const altData: any = await altResp.json();
        if (altData.code === 0 && altData.data) {
          this.logger('备用API成功！');
          return {
            code: 0,
            data: {
              token: altData.data.token || '',
              host_list: altData.data.host_server_list || [
                { host: 'broadcastlv.chat.bilibili.com', port: 2243, wss_port: 443 }
              ],
              live_status: 1
            }
          };
        }
      }
    } catch (error: any) {
      this.logger('备用API失败:', error.message);
    }
    
    // 尝试自动获取签名
    try {
      this.logger('尝试自动获取签名参数...');
      const { wRid, wts } = await autoFetchSignature(roomId, this.cookie);
      const data = await tryOnce({ wRid, wts, label: 'auto-fetch' });
      if (data.code === 0) {
        this.logger('自动获取签名成功！');
        return data;
      }
    } catch (error: any) {
      this.logger('自动获取签名失败:', error.message);
    }
    
    // 动态生成签名
    for (let attempt = 0; attempt < 3; attempt++) {
      const { wRid, wts } = await resolveDanmakuQuery({
        cookie: this.cookie,
        roomId,
        type: this.danmakuType,
        web_location: this.webLocation
      });
      const label = attempt === 0 ? 'dynamic' : `dynamic retry ${attempt}`;
      const data = await tryOnce({ wRid, wts, label });
      if (data.code === 0) return data;
      if (data.code === -352) {
        this.logger(`getDanmuInfo 签名失败 (${label})，重新获取`);
        continue;
      }
      return data;
    }
    
    // 最后尝试默认参数
    this.logger('使用默认参数直接连接...');
    return {
      code: 0,
      data: {
        token: '',
        host_list: [{ host: 'broadcastlv.chat.bilibili.com', port: 2243, wss_port: 443 }]
      }
    };
  }
}
