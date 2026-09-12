import fs from 'fs';
import path from 'path';

const root = 'D:/a/fzu-exam-automation-release';
const files = fs.readdirSync(root)
  .filter((name) => /^(review-.*|acct.*review.*)\.json$/i.test(name))
  .map((name) => path.join(root, name));

function normalizeText(value) {
  return String(value || '')
    .replace(/^\s*\d+\s*[.、]\s*/, '')
    .replace(/^[A-E]\s*[.、]\s*/, '')
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, '')
    .trim();
}
function parseOptions(options) {
  const parsed = {};
  for (const item of options || []) {
    const text = String(item && item.text || '').trim();
    const m = text.match(/^([A-E])\s*[.、]\s*(.*)$/);
    if (m) parsed[m[1]] = m[2].trim();
  }
  return parsed;
}
function bankKey(title, options) {
  const titleKey = normalizeText(title);
  const optionKey = Object.values(options).map(normalizeText).sort().join('|');
  return titleKey + '::' + optionKey;
}
const questions = {};
const conflicts = [];
let records = 0, skipped = 0;
const sources = {};
for (const file of files) {
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { skipped++; continue; }
  if (!Array.isArray(list)) { skipped++; continue; }
  for (const record of list) {
    records++;
    const correct = String(record.correct || '').toUpperCase().replace(/[^A-E]/g, '');
    const title = String(record.title || '').trim();
    const options = parseOptions(record.options);
    if (!title || !correct || Object.keys(options).length < 2) { skipped++; continue; }
    const answerTexts = [...correct].map((letter) => options[letter]).filter(Boolean);
    if (!answerTexts.length) { skipped++; continue; }
    const key = bankKey(title, options);
    const entry = { title, options, answerLetters: correct, answerTexts, source: path.basename(file) };
    const prev = questions[key];
    if (prev && prev.answerTexts.join('|') !== answerTexts.join('|')) {
      conflicts.push({ key, prev, next: entry });
      continue;
    }
    questions[key] = entry;
    sources[path.basename(file)] = (sources[path.basename(file)] || 0) + 1;
  }
}
const output = { version: 2, generatedAt: new Date().toISOString(), questions };
fs.writeFileSync(path.join(root, 'question-bank-v2.json'), JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({ reviewFiles: files.length, records, questions: Object.keys(questions).length, conflicts: conflicts.length, skipped, sources }, null, 2));
if (conflicts.length) fs.writeFileSync(path.join(root, 'question-bank-v2-conflicts.json'), JSON.stringify(conflicts, null, 2), 'utf8');
