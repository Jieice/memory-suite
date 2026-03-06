#!/usr/bin/env node
/**
 * 弹幕配置检测脚本
 * 用法: node scripts/check-danmaku-config.js
 * 
 * 功能:
 * 1. 检测 config.json 是否存在
 * 2. 验证必要字段
 * 3. 测试 Cookie 有效性
 * 4. 测试房间连接
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, '../memory-danmaku/config.json');
const CONFIG_EXAMPLE = {
  roomId: 0,
  triggerPrefix: "",
  rateLimitMs: 2000,
  replyMinLen: 1,
  danmakuCookie: "",
  userUid: 0,
  buvid: "",
  useWbiSignature: true
};

console.log('🔍 弹幕配置检测工具\n');
console.log('='.repeat(50));

// 1. 检查配置文件
function checkConfigFile() {
  console.log('\n📁 检查配置文件...');
  
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('❌ config.json 不存在');
    console.log('📝 创建示例配置文件...');
    
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_EXAMPLE, null, 2));
    console.log('✅ 已创建 memory-danmaku/config.json');
    console.log('⚠️  请编辑配置文件填入你的信息');
    return null;
  }
  
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    console.log('✅ config.json 存在且格式正确');
    return config;
  } catch (e) {
    console.log('❌ config.json 格式错误:', e.message);
    return null;
  }
}

// 2. 验证必要字段
function validateConfig(config) {
  console.log('\n🔧 验证配置字段...');
  
  const issues = [];
  
  if (!config.roomId || config.roomId === 0) {
    issues.push('roomId: 未设置房间号');
  } else {
    console.log(`✅ roomId: ${config.roomId}`);
  }
  
  if (!config.danmakuCookie) {
    issues.push('danmakuCookie: 未设置 Cookie');
  } else {
    // 检查 Cookie 是否包含必要字段
    const hasSESSDATA = config.danmakuCookie.includes('SESSDATA=');
    const hasDedeUserID = config.danmakuCookie.includes('DedeUserID=');
    const hasBiliJct = config.danmakuCookie.includes('bili_jct=');
    
    if (!hasSESSDATA) issues.push('Cookie 缺少 SESSDATA');
    if (!hasDedeUserID) issues.push('Cookie 缺少 DedeUserID');
    if (!hasBiliJct) issues.push('Cookie 缺少 bili_jct');
    
    if (hasSESSDATA && hasDedeUserID && hasBiliJct) {
      console.log('✅ danmakuCookie: 包含必要字段');
    }
  }
  
  if (!config.userUid || config.userUid === 0) {
    issues.push('userUid: 未设置用户 UID (可从 Cookie 中的 DedeUserID 获取)');
  } else {
    console.log(`✅ userUid: ${config.userUid}`);
  }
  
  if (!config.buvid) {
    console.log('⚠️  buvid: 未设置 (可选，但建议设置)');
  } else {
    console.log(`✅ buvid: ${config.buvid.substring(0, 10)}...`);
  }
  
  if (issues.length > 0) {
    console.log('\n❌ 发现以下问题:');
    issues.forEach(issue => console.log(`   - ${issue}`));
    return false;
  }
  
  return true;
}

// 3. 测试 Cookie 有效性
async function testCookie(config) {
  console.log('\n🍪 测试 Cookie 有效性...');
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.bilibili.com',
      path: '/x/web-interface/nav',
      method: 'GET',
      headers: {
        'Cookie': config.danmakuCookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data?.isLogin) {
            console.log(`✅ Cookie 有效，用户: ${json.data.uname}`);
            console.log(`   UID: ${json.data.mid}`);
            console.log(`   等级: Lv${json.data.level_info?.current_level || '?'}`);
            
            // 自动填充 userUid
            if (!config.userUid || config.userUid === 0) {
              config.userUid = json.data.mid;
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
              console.log(`   📝 已自动填充 userUid: ${json.data.mid}`);
            }
            
            resolve(true);
          } else {
            console.log('❌ Cookie 无效或已过期');
            console.log('   请重新获取 Cookie');
            resolve(false);
          }
        } catch (e) {
          console.log('❌ 解析响应失败:', e.message);
          resolve(false);
        }
      });
    });
    
    req.on('error', (e) => {
      console.log('❌ 网络请求失败:', e.message);
      resolve(false);
    });
    
    req.setTimeout(10000, () => {
      console.log('❌ 请求超时');
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

// 4. 测试房间连接
async function testRoom(config) {
  console.log('\n🏠 测试房间连接...');
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.live.bilibili.com',
      path: `/room/v1/Room/get_info?room_id=${config.roomId}`,
      method: 'GET',
      headers: {
        'Cookie': config.danmakuCookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data) {
            const room = json.data;
            console.log(`✅ 房间信息获取成功`);
            console.log(`   房间号: ${room.room_id} (短号: ${room.short_id || '无'})`);
            console.log(`   主播: ${room.uid}`);
            console.log(`   状态: ${room.live_status === 1 ? '🔴 直播中' : '⚫ 未开播'}`);
            console.log(`   标题: ${room.title}`);
            resolve(true);
          } else {
            console.log('❌ 房间不存在或无法访问');
            console.log(`   错误: ${json.message || '未知错误'}`);
            resolve(false);
          }
        } catch (e) {
          console.log('❌ 解析响应失败:', e.message);
          resolve(false);
        }
      });
    });
    
    req.on('error', (e) => {
      console.log('❌ 网络请求失败:', e.message);
      resolve(false);
    });
    
    req.setTimeout(10000, () => {
      console.log('❌ 请求超时');
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

// 主流程
async function main() {
  const config = checkConfigFile();
  if (!config) {
    printHelp();
    process.exit(1);
  }
  
  const valid = validateConfig(config);
  if (!valid) {
    printHelp();
    process.exit(1);
  }
  
  const cookieOk = await testCookie(config);
  if (!cookieOk) {
    printCookieHelp();
    process.exit(1);
  }
  
  const roomOk = await testRoom(config);
  
  console.log('\n' + '='.repeat(50));
  if (cookieOk && roomOk) {
    console.log('✅ 所有检测通过！可以启动弹幕服务了');
    console.log('\n启动命令:');
    console.log('  cd memory-danmaku && node bridge.js');
    console.log('  或使用 Manager 启动');
  } else {
    console.log('⚠️  部分检测未通过，请修复后重试');
  }
}

function printHelp() {
  console.log(`
📖 配置说明:

1. roomId: B站直播间房间号
   - 打开直播间，URL 中的数字就是房间号
   - 例如: https://live.bilibili.com/12345 → roomId: 12345

2. danmakuCookie: B站完整 Cookie
   - 打开 B站，按 F12 → Application → Cookies
   - 复制所有 Cookie 值，格式如:
     "SESSDATA=xxx; DedeUserID=xxx; bili_jct=xxx; ..."

3. userUid: 你的 B站 UID
   - 可从 Cookie 中的 DedeUserID 获取
   - 或登录后访问个人主页查看

4. buvid: 设备标识 (可选)
   - 从 Cookie 中的 buvid3 或 buvid4 获取
`);
}

function printCookieHelp() {
  console.log(`
🍪 如何获取 Cookie:

1. 打开 Chrome/Edge 浏览器
2. 登录 B站 (bilibili.com)
3. 按 F12 打开开发者工具
4. 切换到 Application (应用) 标签
5. 左侧找到 Cookies → https://www.bilibili.com
6. 复制以下字段的值:
   - SESSDATA
   - DedeUserID  
   - bili_jct
   - buvid3 或 buvid4

7. 拼接成完整 Cookie:
   "SESSDATA=xxx; DedeUserID=xxx; bili_jct=xxx; buvid3=xxx"

⚠️  注意: Cookie 会过期，如果连接失败请重新获取
`);
}

main().catch(console.error);
