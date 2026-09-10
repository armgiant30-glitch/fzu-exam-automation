#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const DEFAULT_EXAM = "https://exam.yooc.me/group/10683137/exam/596408";
const DEFAULT_TAKE = DEFAULT_EXAM + "/take";
const DEFAULT_REVIEW = DEFAULT_EXAM + "/review";
const TOTAL_QUESTIONS = 100;
const HERE = __dirname;
const QUESTION_BANK = path.join(HERE, "question-bank.json");

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function newestDirectory(root, predicate) {
  if (!exists(root)) return null;
  const items = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && predicate(path.join(root, entry.name)))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return items.length ? items[items.length - 1] : null;
}

function findNodeRepl() {
  const candidates = [];
  if (process.env.CODEX_MCP_NODE_PATH) {
    candidates.push(path.join(path.dirname(process.env.CODEX_MCP_NODE_PATH), "node_repl.exe"));
  }
  const runtimeRoot = path.join(HOME, "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node");
  const runtime = newestDirectory(runtimeRoot, (dir) => exists(path.join(dir, "bin", "node_repl.exe")));
  if (runtime) candidates.push(path.join(runtime, "bin", "node_repl.exe"));
  const found = candidates.find(exists);
  if (!found) throw new Error("node_repl.exe not found. Run this script from Codex Desktop.");
  const bin = path.dirname(found);
  return { exe: found, bin, node: path.join(bin, "node.exe"), nodeModules: path.join(bin, "node_modules") };
}

function findBrowserClient() {
  const root = path.join(HOME, ".codex", "plugins", "cache", "openai-bundled", "browser");
  if (!exists(root)) throw new Error("OpenAI browser plugin cache not found.");
  const versions = fs.readdirSync(root)
    .filter((name) => exists(path.join(root, name, "scripts", "browser-client.mjs")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error("browser-client.mjs not found.");
  const version = versions[versions.length - 1];
  return { version, client: path.join(root, version, "scripts", "browser-client.mjs") };
}

function findCodexCli() {
  const root = path.join(HOME, "AppData", "Local", "OpenAI", "Codex", "bin");
  if (!exists(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "codex.exe"))
    .filter(exists)
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return dirs.length ? dirs[dirs.length - 1] : null;
}

class NodeReplBridge {
  constructor() {
    const repl = findNodeRepl();
    const browser = findBrowserClient();
    const codexCli = findCodexCli();
    this.paths = { ...repl, browserClient: browser.client, browserVersion: browser.version, codexCli };
    this.child = null;
    this.buffer = "";
    this.initialized = false;
    this.nextId = 2;
    this.pending = new Map();
    this.startPromise = null;
  }

  environment() {
    const env = {
      ...process.env,
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
      NODE_REPL_NODE_MODULE_DIRS: this.paths.nodeModules,
      NODE_REPL_NODE_PATH: this.paths.node,
      NODE_REPL_TRUSTED_CODE_PATHS: path.join(HOME, ".codex") + ";" + this.paths.nodeModules,
      CODEX_HOME: path.join(HOME, ".codex"),
      BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
      BROWSER_USE_TINYSKY_ENABLED: "1",
      NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: "",
      NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: "",
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
      BROWSER_USE_CODEX_APP_VERSION: this.paths.browserVersion,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
        browser: this.paths.browserClient.replace(/\\/g, "/"),
        sky: "@oai/sky/service",
      }),
    };
    if (this.paths.codexCli) env.CODEX_CLI_PATH = this.paths.codexCli;
    if (!env.CODEX_SESSION_ID) env.CODEX_SESSION_ID = process.env.CODEX_THREAD_ID || crypto.randomUUID();
    if (!env.CODEX_THREAD_ID) env.CODEX_THREAD_ID = env.CODEX_SESSION_ID;
    return env;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      this.child = spawn(this.paths.exe, [], {
        env: this.environment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child.once("error", reject);
      this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      this.child.stdout.on("data", (chunk) => this.onData(chunk, resolve, reject));
      this.child.on("exit", (code) => {
        if (!this.initialized) reject(new Error("node_repl exited before initialization: " + code));
      });
      this.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { elicitation: {} },
          clientInfo: { name: "fzu-exam-browser", version: "1.0" },
        },
      });
    });
    return this.startPromise;
  }

  onData(chunk, resolveStart, rejectStart) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }

      if (message.id === 1 && !this.initialized) {
        this.initialized = true;
        this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        resolveStart();
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        const text = message.result?.content?.map((item) => item.text || "").join("\n") || JSON.stringify(message);
        if (message.result?.isError) pending.reject(new Error(text));
        else pending.resolve(text);
        continue;
      }
      if (message.method && message.id !== undefined) {
        this.send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: {} } });
      }
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("node_repl bridge is not running");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async runJs(code, title, timeoutMs = 180000) {
    await this.start();
    const id = this.nextId++;
    const turn = JSON.stringify({
      session_id: process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || "local-session",
      turn_id: crypto.randomUUID(),
      thread_id: process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || "local-thread",
      thread_source: "main",
    });
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "js",
          arguments: { code, title, timeout_ms: timeoutMs },
          _meta: { "x-codex-turn-metadata": turn, model: "gpt-5.1-codex" },
        },
      });
    });
  }

  stop() {
    if (this.child && !this.child.killed) this.child.kill();
  }
}

function browserPrelude(targetUrl) {
  return `
const { setupBrowserRuntime } = await import(${JSON.stringify(pathToFileUrl(findBrowserClient().client))});
const agent = await setupBrowserRuntime();
const browser = await agent.browsers.getForUrl(${JSON.stringify(targetUrl)});
const tabs = await browser.tabs.list();
if (!tabs.length) throw new Error("No browser tab is currently open.");
const tab = await browser.tabs.get(tabs[0].id);
`;
}

function pathToFileUrl(filePath) {
  return "file:///" + filePath.replace(/\\/g, "/");
}

function normalizeTitle(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[.、]\s*/, "")
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, "")
    .trim();
}

function parseQuestionRaw(raw) {
  const lines = String(raw || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /^\d+、\[1分\]$/.test(line));
  const title = index >= 0 ? (lines[index + 1] || "") : "";
  const options = lines.filter((line) => /^[A-E][.]/.test(line));
  return { title, options, key: normalizeTitle(title) };
}

function loadQuestionBank(file = QUESTION_BANK) {
  if (!exists(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const bank = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") bank[key] = { answer: value, title: "" };
    else bank[key] = { answer: String(value.answer || ""), title: String(value.title || "") };
  }
  return bank;
}

function saveQuestionBank(bank, file = QUESTION_BANK) {
  const ordered = {};
  for (const key of Object.keys(bank).sort()) ordered[key] = bank[key];
  writeJson(file, ordered);
}

const COMMON_BROWSER_JS = `
async function __body(tab) {
  return await tab.playwright.locator("body").innerText();
}
async function __questionNo(tab) {
  const text = await __body(tab);
  const match = text.match(/(\\d+)\\s*\\/\\s*100/);
  return match ? Number(match[1]) : null;
}
async function __ensureQuestion(tab, target) {
  for (let guard = 0; guard < 130; guard++) {
    const current = await __questionNo(tab);
    if (current === target) return;
    const label = current == null || current > target ? "上一题" : "下一题";
    const before = await __body(tab);
    await tab.playwright.getByText(label).click({ timeoutMs: 10000 });
    for (let k = 0; k < 20; k++) {
      await tab.playwright.waitForTimeout(100);
      if (await __body(tab) !== before) break;
    }
  }
  throw new Error("Could not navigate to question " + target);
}
async function __nextQuestion(tab, before) {
  await tab.playwright.getByText("下一题").click({ timeoutMs: 10000 });
  for (let k = 0; k < 20; k++) {
    await tab.playwright.waitForTimeout(100);
    if (await __body(tab) !== before) return;
  }
}
async function __selectedLetters(tab) {
  return await tab.playwright.evaluate(() =>
    [...document.querySelectorAll("li._c")].map((node) => (node.innerText || "").trim()[0]).join("")
  );
}
function __normalizeTitle(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[.、]\s*/, "")
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, "")
    .trim();
}
async function __questionTitle(tab) {
  const lines = (await __body(tab)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /^\d+、\[1分\]$/.test(line));
  return index >= 0 ? __normalizeTitle(lines[index + 1] || "") : "";
}
`;

function actionDump(bridge) {
  const code = browserPrelude(DEFAULT_TAKE) + `
nodeRepl.write(JSON.stringify({ url: await tab.playwright.evaluate(() => location.href), text: await tab.playwright.locator("body").innerText() }, null, 2));
`;
  return bridge.runJs(code, "读取当前浏览器页面");
}

function actionCollect(bridge) {
  const code = browserPrelude(DEFAULT_TAKE) + COMMON_BROWSER_JS + `
const records = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const before = await __body(tab);
  records.push({ n: n, raw: before });
  if (n < ${TOTAL_QUESTIONS}) await __nextQuestion(tab, before);
}
nodeRepl.write(JSON.stringify(records));
`;
  return bridge.runJs(code, "读取当前考试全部题目");
}

function loadAnswers(answerFile) {
  const file = answerFile
    ? path.resolve(answerFile)
    : path.join(HERE, "answer-key.json");
  if (!exists(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const answers = {};
  for (let i = 1; i <= TOTAL_QUESTIONS; i++) answers[i] = String(raw[i] || raw[String(i)] || "");
  return answers;
}

function actionFill(bridge, answerFile, allowNumericFallback) {
  const numericAnswers = loadAnswers(answerFile);
  const questionBank = loadQuestionBank();
  const code = browserPrelude(DEFAULT_TAKE) + COMMON_BROWSER_JS + `
const numericAnswers = ${JSON.stringify(numericAnswers)};
const questionBank = ${JSON.stringify(questionBank)};
const allowNumericFallback = ${allowNumericFallback ? "true" : "false"};
const filled = [];
const unknown = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const title = await __questionTitle(tab);
  const bankEntry = questionBank[title];
  const letters = (bankEntry && bankEntry.answer) || (allowNumericFallback ? numericAnswers[n] : "");
  if (!letters) {
    unknown.push({ n: n, title: title });
  } else {
    for (const letter of letters) {
      await tab.playwright.getByText(new RegExp("^" + letter + "[.]")).click({ timeoutMs: 10000 });
      await tab.playwright.waitForTimeout(60);
    }
    filled.push({ n: n, title: title, answer: letters, source: bankEntry ? "bank" : "number" });
  }
  if (n < ${TOTAL_QUESTIONS}) {
    const before = await __body(tab);
    await __nextQuestion(tab, before);
  }
}
await __ensureQuestion(tab, 1);
const mismatches = [];
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const title = await __questionTitle(tab);
  const bankEntry = questionBank[title];
  const letters = (bankEntry && bankEntry.answer) || (allowNumericFallback ? numericAnswers[n] : "");
  const got = await __selectedLetters(tab);
  if (letters && got !== letters) mismatches.push({ n: n, title: title, got: got, want: letters });
  if (n < ${TOTAL_QUESTIONS}) {
    const before = await __body(tab);
    await __nextQuestion(tab, before);
  }
}
nodeRepl.write(JSON.stringify({ filled: filled.length, unknown: unknown, mismatches: mismatches, submitted: false }, null, 2));
`;
  return bridge.runJs(code, "按题干匹配题库并填写答案，不提交", 240000);
}

function actionVerify(bridge, answerFile, allowNumericFallback) {
  const numericAnswers = loadAnswers(answerFile);
  const questionBank = loadQuestionBank();
  const code = browserPrelude(DEFAULT_TAKE) + COMMON_BROWSER_JS + `
const numericAnswers = ${JSON.stringify(numericAnswers)};
const questionBank = ${JSON.stringify(questionBank)};
const allowNumericFallback = ${allowNumericFallback ? "true" : "false"};
await __ensureQuestion(tab, 1);
const mismatches = [];
const unknown = [];
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const title = await __questionTitle(tab);
  const bankEntry = questionBank[title];
  const letters = (bankEntry && bankEntry.answer) || (allowNumericFallback ? numericAnswers[n] : "");
  if (!letters) {
    unknown.push({ n: n, title: title });
  } else {
    const got = await __selectedLetters(tab);
    if (got !== letters) mismatches.push({ n: n, title: title, got: got, want: letters });
  }
  if (n < ${TOTAL_QUESTIONS}) {
    const before = await __body(tab);
    await __nextQuestion(tab, before);
  }
}
nodeRepl.write(JSON.stringify({ checked: ${TOTAL_QUESTIONS}, mismatches: mismatches, unknown: unknown }, null, 2));
`;
  return bridge.runJs(code, "按题干校验答案");
}

function actionReview(bridge) {
  const code = browserPrelude(DEFAULT_REVIEW) + COMMON_BROWSER_JS + `
const records = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const page = await __body(tab);
  const options = await tab.playwright.evaluate(() =>
    [...document.querySelectorAll("li")]
      .filter((node) => /^[A-E][.]/.test((node.innerText || "").trim()))
      .map((node) => ({
        text: (node.innerText || "").trim(),
        className: node.className,
        color: node.querySelector("svg") ? getComputedStyle(node.querySelector("svg")).color : null,
        path: node.querySelector("path") ? node.querySelector("path").getAttribute("d") : null,
      }))
  );
  records.push({ n: n, page: page, options: options });
  if (n < ${TOTAL_QUESTIONS}) {
    const before = page;
    await __nextQuestion(tab, before);
  }
}
nodeRepl.write(JSON.stringify(records));
`;
  return bridge.runJs(code, "读取复盘页全部题目", 240000);
}

function parseReviewRecords(records) {
  return records.map((record) => {
    const lines = record.page.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const qIndex = lines.findIndex((line) => /^\d+、\[1分\]$/.test(line));
    const title = qIndex >= 0 ? (lines[qIndex + 1] || "") : "";
    const correct = (record.page.match(/正确答案[：:]\s*([A-E]+)/) || [])[1] || "";
    const yours = (record.page.match(/(?:你的答案|作答|回答)[：:]\s*([A-E]+)/) || [])[1] || "";
    const wrong = /回答错误|答案错误|错误/.test(record.page) || (correct && yours && correct !== yours);
    return { n: record.n, title, key: normalizeTitle(title), correct, yours, wrong, options: record.options };
  });
}

function writeJson(file, data) {
  fs.writeFileSync(path.resolve(file), JSON.stringify(data, null, 2), "utf8");
}

function usage() {
  console.log(`FZU exam browser helper

Usage:
  node fzu-exam-browser.js dump
  node fzu-exam-browser.js collect [questions.json]
  node fzu-exam-browser.js fill [answer-key.json] [--allow-number-fallback]
  node fzu-exam-browser.js verify [answer-key.json] [--allow-number-fallback]
  node fzu-exam-browser.js review [review.json]
  node fzu-exam-browser.js learn [review.json]
  node fzu-exam-browser.js bank

Question matching:
  fill and verify match by normalized question text in question-bank.json first.
  Numeric answer-key.json is only used with --allow-number-fallback.

Safety:
  No command ever clicks the submit button.
`);
}

async function main() {
  const action = process.argv[2] || "help";
  if (action === "help" || action === "--help" || action === "-h") return usage();

  const bridge = new NodeReplBridge();
  try {
    if (action === "dump") {
      console.log(await actionDump(bridge));
      return;
    }
    if (action === "collect") {
      const text = await actionCollect(bridge);
      const records = JSON.parse(text).map((record) => ({ n: record.n, ...parseQuestionRaw(record.raw), raw: record.raw }));
      const out = process.argv[3] || path.join(HERE, "questions.json");
      writeJson(out, records);
      console.log("Collected " + records.length + " questions -> " + path.resolve(out));
      return;
    }
    if (action === "fill") {
      const result = JSON.parse(await actionFill(bridge, process.argv[3], process.argv.includes("--allow-number-fallback")));
      if (result.unknown && result.unknown.length) {
        writeJson(path.join(HERE, "unknown-questions.json"), result.unknown);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.unknown && result.unknown.length) console.log("Unknown questions -> " + path.join(HERE, "unknown-questions.json"));
      return;
    }
    if (action === "verify") {
      console.log(await actionVerify(bridge, process.argv[3], process.argv.includes("--allow-number-fallback")));
      return;
    }
    if (action === "review") {
      const text = await actionReview(bridge);
      const records = parseReviewRecords(JSON.parse(text));
      const out = process.argv[3] || path.join(HERE, "review.json");
      writeJson(out, records);
      const wrong = records.filter((record) => record.wrong);
      if (wrong.length) {
        console.log("Wrong questions:");
        for (const item of wrong) {
          console.log(item.n + ". " + item.title + " | correct: " + item.correct + " | yours: " + (item.yours || "unknown"));
        }
      } else {
        console.log("Review saved -> " + path.resolve(out));
      }
      return;
    }
    if (action === "learn") {
      const file = process.argv[3] ? path.resolve(process.argv[3]) : path.join(HERE, "review.json");
      const records = JSON.parse(fs.readFileSync(file, "utf8"));
      const bank = loadQuestionBank();
      let added = 0, updated = 0;
      for (const record of records) {
        const key = record.key || normalizeTitle(record.title || "");
        const answer = String(record.correct || record.answer || "").trim();
        if (!key || !answer) continue;
        if (bank[key]) updated++;
        else added++;
        bank[key] = { answer, title: record.title || bank[key]?.title || "" };
      }
      saveQuestionBank(bank);
      console.log("Question bank updated: " + Object.keys(bank).length + " keys (+" + added + ", updated " + updated + ") -> " + QUESTION_BANK);
      return;
    }
    if (action === "bank") {
      const bank = loadQuestionBank();
      console.log("Question bank: " + Object.keys(bank).length + " keys -> " + QUESTION_BANK);
      return;
    }
    usage();
  } finally {
    bridge.stop();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
