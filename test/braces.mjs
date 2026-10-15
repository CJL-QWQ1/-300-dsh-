/**
 * 极简括号深度探针：跳过字符串与注释，逐行报告未闭合的位置。
 * 用法：node test/braces.mjs <file>
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node test/braces.mjs <file>');
  process.exit(2);
}
const text = fs.readFileSync(file, 'utf8');
const stack = [];
let inString = null;
let inLineComment = false;
let inBlockComment = false;
const pairs = { ')': '(', ']': '[', '}': '{' };

for (let index = 0; index < text.length; index += 1) {
  const char = text[index];
  const next = text[index + 1];
  if (inLineComment) {
    if (char === '\n') inLineComment = false;
    continue;
  }
  if (inBlockComment) {
    if (char === '*' && next === '/') { inBlockComment = false; index += 1; }
    continue;
  }
  if (inString) {
    if (char === '\\') { index += 1; continue; }
    if (char === inString) inString = null;
    continue;
  }
  if (char === '/' && next === '/') { inLineComment = true; index += 1; continue; }
  if (char === '/' && next === '*') { inBlockComment = true; index += 1; continue; }
  if (char === '"' || char === '\'' || char === '`') { inString = char; continue; }
  if (char === '(' || char === '[' || char === '{') {
    stack.push({ char, line: text.slice(0, index).split('\n').length });
    continue;
  }
  if (char === ')' || char === ']' || char === '}') {
    const want = pairs[char];
    const top = stack.pop();
    if (!top) {
      console.log(`多余的 ${char} @ line ${text.slice(0, index).split('\n').length}`);
    } else if (top.char !== want) {
      console.log(`不匹配：期望闭合 ${top.char}(line ${top.line})，实际 ${char} @ line ${text.slice(0, index).split('\n').length}`);
    }
  }
}
if (stack.length) {
  console.log('未闭合：', stack.map((entry) => `${entry.char}@line ${entry.line}`).join(', '));
} else {
  console.log('括号全部配对');
}
