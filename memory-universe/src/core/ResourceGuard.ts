import os from 'os';

export type ResourceSnapshot = {
  cpuUsage: number;
  memUsage: number;
  timestamp: number;
};

export type ResourceGuardOptions = {
  enabled: boolean;
  cpuThreshold: number;
  memThreshold: number;
  sampleIntervalMs: number;
};

type CpuTimes = {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
};

function readCpuTimes(): CpuTimes[] {
  return os.cpus().map(cpu => cpu.times);
}

function computeCpuUsage(prev: CpuTimes[], next: CpuTimes[]): number {
  if (!prev.length || prev.length !== next.length) return 0;
  let totalUsage = 0;

  for (let i = 0; i < next.length; i += 1) {
    const p = prev[i];
    const n = next[i];
    const prevTotal = p.user + p.nice + p.sys + p.idle + p.irq;
    const nextTotal = n.user + n.nice + n.sys + n.idle + n.irq;
    const totalDelta = nextTotal - prevTotal;
    const idleDelta = n.idle - p.idle;
    const usage = totalDelta > 0 ? 1 - idleDelta / totalDelta : 0;
    totalUsage += usage;
  }

  return (totalUsage / next.length) * 100;
}

export class ResourceGuard {
  private readonly enabled: boolean;
  private readonly cpuThreshold: number;
  private readonly memThreshold: number;
  private readonly sampleIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastCpuTimes: CpuTimes[] = readCpuTimes();
  private lastSnapshot: ResourceSnapshot = {
    cpuUsage: 0,
    memUsage: 0,
    timestamp: Date.now()
  };

  constructor(options: ResourceGuardOptions) {
    this.enabled = options.enabled;
    this.cpuThreshold = options.cpuThreshold;
    this.memThreshold = options.memThreshold;
    this.sampleIntervalMs = options.sampleIntervalMs;
    this.lastSnapshot = this.sample();
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.sample();
    }, this.sampleIntervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isOverloaded(): boolean {
    if (!this.enabled) return false;
    const snapshot = this.lastSnapshot || this.sample();
    return snapshot.cpuUsage >= this.cpuThreshold || snapshot.memUsage >= this.memThreshold;
  }

  getSnapshot(): ResourceSnapshot {
    return this.lastSnapshot || this.sample();
  }

  private sample(): ResourceSnapshot {
    const nextCpu = readCpuTimes();
    const cpuUsage = computeCpuUsage(this.lastCpuTimes, nextCpu);
    this.lastCpuTimes = nextCpu;
    const memUsage = this.getMemUsage();
    this.lastSnapshot = {
      cpuUsage,
      memUsage,
      timestamp: Date.now()
    };
    return this.lastSnapshot;
  }

  private getMemUsage(): number {
    const total = os.totalmem();
    const free = os.freemem();
    if (!total) return 0;
    return ((total - free) / total) * 100;
  }
}
