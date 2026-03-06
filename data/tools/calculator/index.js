#!/usr/bin/env node
/**
 * 计算器工具 - 安全的数学表达式计算
 */

const args = JSON.parse(process.argv[2] || '{}');
const expression = args.expression || '';

// 安全的表达式计算（只允许数字和基本运算符）
function safeEval(expr) {
  // 清理表达式
  let cleaned = expr
    .replace(/\s+/g, '')           // 移除空格
    .replace(/×/g, '*')            // 中文乘号
    .replace(/÷/g, '/')            // 中文除号
    .replace(/％/g, '/100')        // 百分号
    .replace(/%/g, '/100')         // 百分号
    .replace(/\^/g, '**')          // 幂运算
    .replace(/（/g, '(')           // 中文括号
    .replace(/）/g, ')');          // 中文括号
  
  // 验证表达式只包含安全字符
  if (!/^[\d+\-*/().%\s]+$/.test(cleaned.replace(/\*\*/g, ''))) {
    throw new Error('表达式包含不支持的字符');
  }
  
  // 使用 Function 构造器进行安全计算
  try {
    const result = Function('"use strict"; return (' + cleaned + ')')();
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('计算结果无效');
    }
    return result;
  } catch (e) {
    throw new Error('表达式格式错误');
  }
}

try {
  const result = safeEval(expression);
  
  // 格式化结果
  let formatted;
  if (Number.isInteger(result)) {
    formatted = result.toString();
  } else {
    // 保留合理的小数位数
    formatted = parseFloat(result.toPrecision(10)).toString();
  }
  
  const content = `${expression} = ${formatted}`;
  
  console.log(JSON.stringify({
    expression: expression,
    result: result,
    content: content
  }));
} catch (error) {
  console.log(JSON.stringify({
    expression: expression,
    error: error.message,
    content: `计算失败：${error.message}`
  }));
}
