import { ServiceConfig, Service } from '../types/service';
import * as fs from 'fs';
import * as path from 'path';

type LogEntry = { type: string; message: string; timestamp: string };

function hasSuiteFolders(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'memory-tts')) &&
    fs.existsSync(path.join(dir, 'memory-universe'))
  );
}

function resolveSuiteRoot(): string {
  const cwd = process.cwd();
  if (hasSuiteFolders(cwd)) return cwd;
  const parent = path.resolve(cwd, '..');
  if (hasSuiteFolders(parent)) return parent;

  let current = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (hasSuiteFolders(current)) return current;
    const next = path.resolve(current, '..');
    if (next === current) break;
    current = next;
  }
  return parent;
}

const SUITE_ROOT = resolveSuiteRoot();
const LOG_PATHS: Record<string, { out: string; error: string }> = {
  'memory-universe': {
    out: path.join(SUITE_ROOT, 'memory-universe', 'logs', 'mu-out.log'),
    error: path.join(SUITE_ROOT, 'memory-universe', 'logs', 'mu-error.log')
  },
  'memory-tts': {
    out: path.join(SUITE_ROOT, 'memory-tts', 'logs', 'tts-out.log'),
    error: path.join(SUITE_ROOT, 'memory-tts', 'logs', 'tts-error.log')
  },
  live2d: {
    out: path.join(SUITE_ROOT, 'memory-live2d', 'logs', 'live2d-out.log'),
    error: path.join(SUITE_ROOT, 'memory-live2d', 'logs', 'live2d-error.log')
  },
  danmaku: {
    out: path.join(SUITE_ROOT, 'memory-danmaku', 'logs', 'danmaku-out.log'),
    error: path.join(SUITE_ROOT, 'memory-danmaku', 'logs', 'danmaku-error.log')
  },
  brainnn: {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'brainnn-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'brainnn-error.log')
  },
  'agent-core': {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'agent-core-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'agent-core-error.log')
  },
  'memory-system-v2': {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'memory-system-v2-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'memory-system-v2-error.log')
  },
  'reflection-engine': {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'reflection-engine-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'reflection-engine-error.log')
  },
  'neuro-symbolic-bridge': {
    out: path.join(SUITE_ROOT, 'brainnn', 'logs', 'neuro-symbolic-bridge-out.log'),
    error: path.join(SUITE_ROOT, 'brainnn', 'logs', 'neuro-symbolic-bridge-error.log')
  }
};

function readLastLines(filePath: string, lineCount = 100): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}

function buildLogEntries(lines: string[], type: 'stdout' | 'stderr'): LogEntry[] {
  return lines.map(line => ({
    type,
    message: line,
    timestamp: new Date().toLocaleTimeString()
  }));
}

export class ServiceService {
  private services: ServiceConfig;

  constructor(services: ServiceConfig) {
    this.services = services;
  }
  /**
   * List all services
   */
  listServices() {
    const result: Array<{
      id: string;
      name: string;
      port: number;
      status: string;
      priority: number;
      group: string;
      logCount: number;
    }> = [];
    
    for (const id in this.services) {
      const service = this.services[id];
      if (!service) continue;
      
      // Type assertion to tell TypeScript service is not null
      const s = service as Service;
      result.push({
        id,
        name: s.name,
        port: s.port,
        status: s.status || 'stopped',
        priority: s.priority || 0,
        group: s.group || 'default',
        logCount: Array.isArray(s.logs) ? s.logs.length : 0
      });
    }
    
    return result;
  }

  /**
   * Get service logs
   */
  getServiceLogs(serviceId: string, limit = 100) {
    const service = this.services[serviceId];
    if (!service) return null;

    const logPaths = LOG_PATHS[serviceId];
    if (logPaths) {
      const outLines = readLastLines(logPaths.out, limit);
      const errorLines = readLastLines(logPaths.error, limit);
      const fileLogs = [
        ...buildLogEntries(outLines, 'stdout'),
        ...buildLogEntries(errorLines, 'stderr')
      ];
      if (fileLogs.length > 0) return fileLogs;
    }

    return service.logs || [];
  }

  /**
   * Start a service
   */
  async startService(serviceId: string): Promise<boolean> {
    const service = this.services[serviceId];
    if (!service) return false;
    
    if (service.status === 'running') return false;
    
    // Start service logic would be here
    service.status = 'running';
    return true;
  }

  /**
   * Stop a service
   */
  async stopService(serviceId: string): Promise<boolean> {
    const service = this.services[serviceId];
    if (!service) return false;
    
    if (service.status !== 'running') return false;
    
    // Stop service logic would be here
    service.status = 'stopped';
    return true;
  }

  /**
   * Start all services
   */
  async startAllServices() {
    const results: Record<string, boolean> = {};
    const sortedIds = Object.keys(this.services)
      .filter(id => this.services[id] !== null)
      .sort((a, b) => {
        const serviceA = this.services[a];
        const serviceB = this.services[b];
        if (!serviceA || !serviceB) return 0;
        return (serviceB.priority || 0) - (serviceA.priority || 0);
      });
    
    for (const id of sortedIds) {
      const service = this.services[id];
      if (service) {
        results[id] = await this.startService(id);
      }
    }
    
    return results;
  }

  /**
   * Stop all services
   */
  async stopAllServices() {
    const results: Record<string, boolean> = {};
    const sortedIds = Object.keys(this.services)
      .filter(id => this.services[id] !== null)
      .sort((a, b) => {
        const serviceA = this.services[a];
        const serviceB = this.services[b];
        if (!serviceA || !serviceB) return 0;
        return (serviceA.priority || 0) - (serviceB.priority || 0);
      });
    
    for (const id of sortedIds) {
      const service = this.services[id];
      if (service) {
        results[id] = await this.stopService(id);
      }
    }
    
    return results;
  }

  /**
   * Force cleanup of all ports
   */
  async forceCleanup(): Promise<number[]> {
    const cleanedPorts = [];
    const allPorts = [4014, 4002, 4003, 4005, 4006, 4007, 8081, 9222, 9933];
    
    // Cleanup logic would be here
    // For now, just return the list of ports
    return allPorts;
  }

  /**
   * Check service health
   */
  async checkServiceHealth(serviceId: string) {
    const service = this.services[serviceId];
    if (!service) return null;
    
    return {
      service: serviceId,
      status: service.status,
      port: service.port,
      uptime: (service as any).uptime || 0
    };
  }

  /**
   * Health check for all services
   */
  async healthCheck() {
    const results = {
      timestamp: new Date().toISOString(),
      checks: [] as any[]
    };
    
    for (const [id, service] of Object.entries(this.services)) {
      if (service) {
        results.checks.push({
          service: id,
          status: service.status || 'stopped',
          port: service.port
        });
      }
    }
    
    return results;
  }

  /**
   * Get overall health status
   */
  getHealthStatus() {
    const serviceStatuses = Object.keys(this.services)
      .filter(id => this.services[id])
      .map(id => {
        const service = this.services[id];
        if (!service) return null;
        return {
          id,
          status: service.status || 'stopped',
          port: service.port
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    
    return {
      status: 'healthy',
      services: serviceStatuses,
      uptime: process.uptime()
    };
  }
}
