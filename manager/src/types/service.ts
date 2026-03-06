export interface Service {
  name: string;
  port: number;
  cwd: string;
  command: string;
  args: string[];
  status: 'stopped' | 'running' | 'error';
  logs: Array<{ type: string; message: string; timestamp: string }>;
  process?: any;
  priority?: number;
  group?: string;
  description?: string;
  useShell?: boolean;
  env?: Record<string, string>;
}

export interface ServiceConfig {
  [key: string]: Service | null;
}

export interface ServiceHealth {
  service: string;
  status: 'healthy' | 'unhealthy' | 'stopped';
  port: number;
  uptime?: number;
}
