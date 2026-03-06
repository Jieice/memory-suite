#!/usr/bin/env node
/**
 * 随机工具 - 随机选择、随机数、掷骰子
 */

const args = JSON.parse(process.argv[2] || '{}');

// 检测调用的是哪个功能
if (args.options && Array.isArray(args.options)) {
  // random_choice
  const options = args.options;
  const count = Math.min(args.count || 1, options.length);
  
  const shuffled = [...options].sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, count);
  
  const content = count === 1 
    ? `我帮你选了：${chosen[0]}`
    : `我帮你选了 ${count} 个：${chosen.join('、')}`;
  
  console.log(JSON.stringify({ chosen, content }));
  
} else if (args.sides !== undefined || args.rolls !== undefined) {
  // dice_roll
  const sides = args.sides || 6;
  const count = args.count || 1;
  
  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0);
  
  const content = count === 1
    ? `🎲 掷出了 ${rolls[0]} 点`
    : `🎲 掷了 ${count} 个 ${sides} 面骰子：${rolls.join(', ')}，总计 ${total} 点`;
  
  console.log(JSON.stringify({ rolls, total, content }));
  
} else {
  // random_number
  const min = args.min ?? 1;
  const max = args.max ?? 100;
  const count = args.count || 1;
  
  const numbers = [];
  for (let i = 0; i < count; i++) {
    numbers.push(Math.floor(Math.random() * (max - min + 1)) + min);
  }
  
  const content = count === 1
    ? `随机数是：${numbers[0]}`
    : `生成了 ${count} 个随机数：${numbers.join(', ')}`;
  
  console.log(JSON.stringify({ numbers, content }));
}
