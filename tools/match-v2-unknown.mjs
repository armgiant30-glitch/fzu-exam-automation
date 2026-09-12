import fs from 'fs';
import path from 'path';

const [questionsFile, outputFile = 'unknown-questions.json'] = process.argv.slice(2);
if (!questionsFile) {
  console.error('Usage: node match-v2-unknown.mjs questions.json [unknown-questions.json]');
  process.exit(1);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const bankFile = path.join(root, 'question-bank-v2.json');
const questions = JSON.parse(fs.readFileSync(path.resolve(questionsFile), 'utf8'));
const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8')).questions || {};

function norm(value) {
  return String(value || '')
    .replace(/^\s*\d+\s*[.、]\s*/, '')
    .replace(/^[A-E]\s*[.、]\s*/, '')
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, '')
    .trim();
}
function parseOptions(options) {
  const parsed = {};
  for (const item of options || []) {
    const text = typeof item === 'string' ? item : String(item && item.text || '');
    const match = text.match(/^([A-E])\s*[.、]\s*(.*)$/);
    if (match) parsed[match[1]] = match[2].trim();
  }
  return parsed;
}
function key(title, options) {
  return norm(title) + '::' + Object.values(options).map(norm).sort().join('|');
}
const unknown = [];
let matched = 0;
for (const q of questions) {
  const options = parseOptions(q.options);
  const entry = bank[key(q.title, options)];
  const currentTexts = new Set(Object.values(options).map(norm));
  const ok = entry && (entry.answerTexts || []).length && entry.answerTexts.every((text) => currentTexts.has(norm(text)));
  if (ok) matched++; else unknown.push(q);
}
fs.writeFileSync(path.resolve(outputFile), JSON.stringify(unknown, null, 2), 'utf8');
console.log(JSON.stringify({ total: questions.length, matched, unknown: unknown.length, output: path.resolve(outputFile) }, null, 2));
