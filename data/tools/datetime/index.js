#!/usr/bin/env node
/**
 * 日期时间工具 - 获取当前时间信息
 */

const args = JSON.parse(process.argv[2] || '{}');
const timezone = args.timezone || 'Asia/Shanghai';
const format = args.format || 'full';

const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const now = new Date();
const options = { timeZone: timezone };

const dateStr = now.toLocaleDateString('zh-CN', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeStr = now.toLocaleTimeString('zh-CN', { ...options, hour12: false });
const weekday = weekdays[now.getDay()];

const result = {
  datetime: `${dateStr} ${timeStr}`,
  date: dateStr,
  time: timeStr,
  weekday: weekday,
  timestamp: now.getTime(),
  timezone: timezone
};

// 根据格式输出
let output;
if (format === 'date') {
  output = `今天是 ${dateStr} ${weekday}`;
} else if (format === 'time') {
  output = `现在是 ${timeStr}`;
} else {
  output = `现在是 ${dateStr} ${weekday} ${timeStr}`;
}

console.log(JSON.stringify({ content: output, ...result }));
