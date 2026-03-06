/**
 * PortManager - 完美的端口管理解决方?
 * 
 * 解决问题：?
 * 1. 端口占用检测不准确
 * 2. 进程清理不彻?
 * 3. 孤儿进程问题
 */

const { execSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT_CACHE_TTL_MS = 2000;
let portPidCacheAt = 0;
let portPidCache = new Map();

// PID 文件存储目录
const PID_DIR = path.join(__dirname, '../data/pids');

// 确保 PID 目录存在
if (!fs.existsSync(PID_DIR)) {
  fs.mkdirSync(PID_DIR, { recursive: true });
}

/**
 * 检查端口是否被占用（使?TCP 连接测试，最可靠?
 */
function isPortInUse(port) {
  if (process.platform === 'win32') {
    return Promise.resolve(Boolean(getPortPid(port)));
  }

  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });

    server.once('listening', () => {
      server.close();
      resolve(false);
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * 获取占用端口?PID（Windows 专用，更可靠的方法）
 */
function getPortPid(port) {
  if (process.platform !== 'win32') return null;

  const now = Date.now();
  if (now - portPidCacheAt > PORT_CACHE_TTL_MS) {
    refreshPortPidCache();
  }

  const cached = portPidCache.get(port);
  if (cached) return cached;

  try {
    const command = 'powershell -Command "Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess"';
    const result = execSync(command, { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();

    if (result && !isNaN(result)) {
      return parseInt(result, 10);
    }
  } catch {
    // ignore
  }

  return null;
}

function refreshPortPidCache() {
  portPidCacheAt = Date.now();
  portPidCache = new Map();

  try {
    const result = execSync('netstat -ano | findstr "LISTENING"', { encoding: 'utf8', windowsHide: true, timeout: 5000 });

    const lines = result.split(/\r?\n/).filter(l => l.trim());
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const local = parts[1];
      const pid = parts[parts.length - 1];
      const match = local.match(/:(\d+)$/);
      if (!match) continue;
      const portNum = parseInt(match[1], 10);
      const pidNum = parseInt(pid, 10);
      if (!isNaN(portNum) && !isNaN(pidNum) && pidNum > 0) {
        if (!portPidCache.has(portNum)) {
          portPidCache.set(portNum, pidNum);
        }
      }
    }
  } catch {
    portPidCache = new Map();
  }
}

/**
 * 强制杀死进程（通过 PID?
 */
function killProcess(pid) {
  if (!pid || pid === 0) return false;
  
  if (process.platform === 'win32') {
    try {
      // /T 杀死进程树?F 强制
      execSync(`taskkill /PID ${pid} /T /F`, {
        windowsHide: true,
        timeout: 10000,
        stdio: 'ignore'
      });
      return true;
    } catch (e) {
      // 进程可能已经退?
      return false;
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch (e) {
      return false;
    }
  }
}

/**
 * 清理端口（杀死占用端口的进程?
 */
async function cleanupPort(port, serviceName = '') {
  const inUse = await isPortInUse(port);
  
  if (!inUse) {
    console.log(`[PortManager] 端口 ${port} 未被占用`);
    return true;
  }
  
  const pid = getPortPid(port);
  
  if (pid) {
    console.log(`[PortManager] 端口 ${port} ?PID ${pid} 占用${serviceName ? ` (${serviceName})` : ''}`);
    
    const killed = killProcess(pid);
    
    if (killed) {
      console.log(`[PortManager] 已杀?PID ${pid}`);
      
      // 等待端口释放
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 验证端口已释?
      const stillInUse = await isPortInUse(port);
      if (stillInUse) {
        console.warn(`[PortManager] 警告：端口?${port} 仍被占用，可能需要手动处理`);
        return false;
      }
      
      return true;
    } else {
      console.warn(`[PortManager] 无法杀?PID ${pid}`);
      return false;
    }
  } else {
    console.warn(`[PortManager] 端口 ${port} 被占用但无法获取 PID`);
    return false;
  }
}

/**
 * 保存服务 PID 到文件（用于追踪孤儿进程?
 */
function savePid(serviceName, pid) {
  const pidFile = path.join(PID_DIR, `${serviceName}.pid`);
  fs.writeFileSync(pidFile, String(pid), 'utf8');
  console.log(`[PortManager] 保存 ${serviceName} PID: ${pid}`);
}

/**
 * 读取服务 PID
 */
function loadPid(serviceName) {
  const pidFile = path.join(PID_DIR, `${serviceName}.pid`);
  
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(pid) && pid > 0) {
      return pid;
    }
  }
  
  return null;
}

/**
 * 删除 PID 文件
 */
function removePid(serviceName) {
  const pidFile = path.join(PID_DIR, `${serviceName}.pid`);
  
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
    console.log(`[PortManager] 删除 ${serviceName} PID 文件`);
  }
}

/**
 * 检查进程是否存?
 */
function isProcessAlive(pid) {
  if (!pid || pid === 0) return false;
  
  if (process.platform === 'win32') {
    try {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });
      return result.includes(String(pid));
    } catch (e) {
      return false;
    }
  } else {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }
}

/**
 * 清理孤儿进程（启动时调用?
 */
async function cleanupOrphanProcesses(services) {
  console.log('[PortManager] 检查孤儿进?..');
  
  for (const [serviceName, port] of Object.entries(services)) {
    // 1. 检?PID 文件
    const savedPid = loadPid(serviceName);
    
    if (savedPid && isProcessAlive(savedPid)) {
      console.log(`[PortManager] 发现孤儿进程: ${serviceName} (PID: ${savedPid})`);
      killProcess(savedPid);
      removePid(serviceName);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 2. 检查端口占?
    const inUse = await isPortInUse(port);
    
    if (inUse) {
      console.log(`[PortManager] 端口 ${port} (${serviceName}) 被占用，尝试清理...`);
      await cleanupPort(port, serviceName);
    }
  }
  
  console.log('[PortManager] 孤儿进程清理完成');
}

/**
 * 批量清理所有端口?
 */
async function cleanupAllPorts(ports) {
  console.log('[PortManager] 开始清理所有端口?..');
  
  const results = {};
  
  for (const port of ports) {
    results[port] = await cleanupPort(port);
  }
  
  console.log('[PortManager] 端口清理完成');
  return results;
}

/**
 * 等待端口可用
 */
async function waitForPortAvailable(port, timeoutMs = 10000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const inUse = await isPortInUse(port);
    
    if (!inUse) {
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return false;
}

/**
 * 等待端口被占用（服务启动后）
 */
async function waitForPortInUse(port, timeoutMs = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const inUse = await isPortInUse(port);
    
    if (inUse) {
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return false;
}

module.exports = {
  isPortInUse,
  getPortPid,
  killProcess,
  cleanupPort,
  savePid,
  loadPid,
  removePid,
  isProcessAlive,
  cleanupOrphanProcesses,
  cleanupAllPorts,
  waitForPortAvailable,
  waitForPortInUse
};
