import { ServiceConfig } from '../types/service';

// 在运行时由 server.js 写入 globalThis.__managerServices
const runtimeServices = (globalThis as any).__managerServices as ServiceConfig | undefined;

if (!runtimeServices) {
  // 提供更友好的错误，便于排查加载顺序问题
  throw new Error('[manager] services registry not initialized. Ensure server.js loads before TS routes.');
}

export const services: ServiceConfig = runtimeServices;
