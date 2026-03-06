// 日志工具 - 统一的日志输出
export class Logger {
  log(...args: any[]): void {
    console.log(new Date().toLocaleTimeString(), '-', ...args);
  }
  
  error(...args: any[]): void {
    console.error(new Date().toLocaleTimeString(), '- [ERROR]', ...args);
  }
  
  warn(...args: any[]): void {
    console.warn(new Date().toLocaleTimeString(), '- [WARN]', ...args);
  }
  
  info(...args: any[]): void {
    console.info(new Date().toLocaleTimeString(), '- [INFO]', ...args);
  }
}

export const logger = new Logger();
