#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const DEFAULT_EXAM = "https://exam.yooc.me/";
let ACTIVE_EXAM = process.env.FZU_EXAM_URL || DEFAULT_EXAM;
const TOTAL_QUESTIONS = 100;
const HERE = __dirname;
const QUESTION_BANK_V1 = path.join(HERE, "question-bank.json");
const QUESTION_BANK = path.join(HERE, "question-bank-v2.json");

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
    .filter((name) => exists(path.join(root, name, "scripts", "browser-client.mjs")) && exists(path.join(root, name, "scripts", "browser-service.mjs")))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error("browser-client.mjs / browser-service.mjs not found.");
  const version = versions[versions.length - 1];
  return {
    version,
    client: path.join(root, version, "scripts", "browser-client.mjs"),
    service: path.join(root, version, "scripts", "browser-service.mjs"),
  };
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
    this.paths = { ...repl, browserClient: browser.client, browserService: browser.service, browserVersion: browser.version, codexCli };
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
        browser: this.paths.browserService.replace(/\\/g, "/"),
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

  async runJs(code, title, timeoutMs = 180000, _tabKind) {
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

function requirePlaywright() {
  const candidates = [
    process.env.FZU_PLAYWRIGHT_MODULE,
    path.join(HOME, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright"),
    path.join(HERE, "node_modules", "playwright"),
    path.join(HERE, "node_modules", "playwright-core"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (exists(candidate)) return require(candidate);
  }
  try { return require("playwright"); } catch {}
  try { return require("playwright-core"); } catch {}
  throw new Error("Playwright module not found. Run: npm install playwright-core, or set FZU_PLAYWRIGHT_MODULE.");
}

function stripBrowserPrelude(code) {
  return String(code).replace(/\/\/ __FZU_PRELUDE_START__[\s\S]*?\/\/ __FZU_PRELUDE_END__\s*/, "");
}

function normalizeCdpEndpoint(value) {
  let input = String(value || "").trim();
  if (!input) throw new Error("--cdp requires a port or http://host:port URL");
  if (/^\d+$/.test(input)) return "http://127.0.0.1:" + input;
  if (!/^https?:\/\//i.test(input)) input = "http://" + input;
  return input.replace(/\/+$/, "");
}

function probeCdp(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = require("http").get({ host, port, path: "/json/version", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(json && json.Browser ? "http://" + host + ":" + port : null);
        } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function findCdpEndpoint() {
  for (const port of [9222, 9223]) {
    const endpoint = await probeCdp("127.0.0.1", port);
    if (endpoint) return endpoint;
  }
  throw new Error("No CDP browser found on 127.0.0.1:9222/9223.");
}

function commandPath(command) {
  try {
    const tool = process.platform === "win32" ? "where.exe" : "which";
    const output = require("child_process").execFileSync(tool, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch { return null; }
}

function detectBrowserExecutable() {
  const configured = process.env.FZU_BROWSER_PATH || process.env.CHROMIUM_BINARY || process.env.BROWSER_PATH;
  if (configured && exists(configured)) return configured;
  const candidates = [];
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
    candidates.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
    for (const command of ["chrome.exe", "msedge.exe", "chromium.exe"]) {
      const found = commandPath(command);
      if (found) candidates.push(found);
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
    for (const command of ["google-chrome", "microsoft-edge", "chromium", "chromium-browser"]) {
      const found = commandPath(command);
      if (found) candidates.push(found);
    }
  } else {
    for (const command of ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser"]) {
      const found = commandPath(command);
      if (found) candidates.push(found);
    }
    candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  }
  return candidates.find(exists) || null;
}

class CdpBridge {
  constructor(options = {}) {
    this.endpoint = options.endpoint ? normalizeCdpEndpoint(options.endpoint) : null;
    this.browserPath = options.browserPath || null;
    this.userDataDir = options.userDataDir || path.join(HOME, ".fzu-exam-browser", "profile");
    this.headless = Boolean(options.headless);
    this.browser = null;
    this.context = null;
    this.lastOutput = undefined;
  }

  async start() {
    if (this.browser || this.context) return;
    const { chromium } = requirePlaywright();
    if (this.endpoint) {
      try {
        this.browser = await chromium.connectOverCDP(this.endpoint);
        return;
      } catch (error) {
        throw new Error("Cannot connect CDP browser at " + this.endpoint + ": " + (error && error.message ? error.message : String(error)));
      }
    }
    const executablePath = this.browserPath || detectBrowserExecutable();
    const launchOptions = {
      headless: this.headless,
      args: ["--no-first-run", "--disable-default-apps", "--disable-extensions", "--mute-audio"],
    };
    if (executablePath) launchOptions.executablePath = executablePath;
    try {
      this.context = await chromium.launchPersistentContext(this.userDataDir, launchOptions);
    } catch (error) {
      const hint = executablePath
        ? "Detected browser: " + executablePath
        : "No system Chrome/Chromium/Edge found and the Playwright browser may not be installed. Run: npx playwright install chromium";
      throw new Error("Cannot launch browser: " + (error && error.message ? error.message : String(error)) + "\n" + hint);
    }
  }

  async getPage(tabKind) {
    const pages = [];
    if (this.context) pages.push(...this.context.pages());
    if (this.browser) {
      for (const context of this.browser.contexts()) {
        for (const page of context.pages()) pages.push(page);
      }
    }
    if (!pages.length) throw new Error("Browser has no open page.");
    const examPages = pages.filter((page) => String(page.url()).includes("exam.yooc.me"));
    const pool = examPages.length ? examPages : pages;
    if (tabKind) {
      const preferred = pool.find((page) => String(page.url()).includes("/" + tabKind));
      if (preferred) return preferred;
    }
    return pool[0];
  }

  async getOrCreatePage(tabKind) {
    try {
      return await this.getPage(tabKind);
    } catch {}
    if (this.context) return await this.context.newPage();
    if (this.browser) {
      const contexts = this.browser.contexts();
      const context = contexts.length ? contexts[0] : await this.browser.newContext();
      return await context.newPage();
    }
    throw new Error("Browser has no usable page or context.");
  }

  async runJs(code, title, timeoutMs = 180000, tabKind) {
    await this.start();
    const page = await this.getOrCreatePage(tabKind);
    const body = stripBrowserPrelude(code);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("tab", "nodeRepl", body);
    this.lastOutput = undefined;
    const nodeRepl = {
      write: (value) => { this.lastOutput = value; },
      emitImage: async () => {},
    };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Direct browser action timed out: " + title)), timeoutMs);
    });
    try {
      await Promise.race([fn({ playwright: page }, nodeRepl), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return this.lastOutput;
  }

  stop() {
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

function browserPrelude(targetUrl, tabKind) {
  const base = String(targetUrl || DEFAULT_EXAM).replace(/\/+$/, "");
  return `// __FZU_PRELUDE_START__
const { setupBrowserRuntime } = await import(${JSON.stringify(pathToFileUrl(findBrowserClient().client))});
const agent = await setupBrowserRuntime();
const browser = await agent.browsers.getForUrl(${JSON.stringify(base || DEFAULT_EXAM)});
const tabs = await browser.tabs.list();
if (!tabs.length) throw new Error("No browser tab is currently open.");
const preferredKind = ${JSON.stringify(tabKind || "")};
const targetBase = ${JSON.stringify(base)};
const ranked = tabs.map((item) => {
  const url = item.url || "";
  let score = 0;
  if (preferredKind && url.includes("/" + preferredKind)) score += 100;
  if (targetBase && targetBase !== "https://exam.yooc.me" && url.startsWith(targetBase)) score += 50;
  if (url.includes("exam.yooc.me")) score += 10;
  return { item, score };
}).sort((a, b) => b.score - a.score);
if (!ranked[0] || ranked[0].score === 0) {
  throw new Error("No exam.yooc.me tab found. Open the target exam page first.");
}
const tab = await browser.tabs.get(ranked[0].item.id);
// __FZU_PRELUDE_END__
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
  const options = lines.filter((line) => /^[A-Z][.]/.test(line));
  return { title, options, key: normalizeTitle(title) };
}

function normalizeBankText(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[.、]\s*/, "")
    .replace(/^[A-Z]\s*[.、]\s*/, "")
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, "")
    .trim();
}

function parseRecordOptions(options) {
  const parsed = {};
  for (const item of options || []) {
    const text = String(item && item.text || "").trim();
    const match = text.match(/^([A-Z])\s*[.、]\s*(.*)$/);
    if (match) parsed[match[1]] = match[2].trim();
  }
  return parsed;
}

function makeBankKey(title, options) {
  const titleKey = normalizeBankText(title);
  const optionKey = Object.values(options || {}).map(normalizeBankText).sort().join("|");
  return titleKey + "::" + optionKey;
}

function loadQuestionBank(file = QUESTION_BANK) {
  if (!exists(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw && raw.version === 2 && raw.questions) return raw.questions;
  return {};
}

function loadLegacyQuestionBank(file = QUESTION_BANK_V1) {
  if (!exists(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveQuestionBank(bank, file = QUESTION_BANK) {
  const ordered = {};
  for (const key of Object.keys(bank).sort()) ordered[key] = bank[key];
  writeJson(file, { version: 2, generatedAt: new Date().toISOString(), questions: ordered });
}

const COMMON_BROWSER_JS = String.raw`
async function __body(tab) {
  return await tab.playwright.locator("body").innerText();
}
async function __questionNo(tab) {
  const text = await __body(tab);
  const match = text.match(/(\d+)\s*\/\s*100/);
  return match ? Number(match[1]) : null;
}
async function __questionOptions(tab) {
  const lines = (await __body(tab)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const options = {};
  for (const line of lines) {
    const match = line.match(/^([A-Z])\s*[.、]\s*(.*)$/);
    if (match) options[match[1]] = match[2].trim();
  }
  return options;
}
function __normalizeBankText(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[.、]\s*/, "")
    .replace(/^[A-Z]\s*[.、]\s*/, "")
    .replace(/[\s，。；：、,.()（）【】\[\]“”"'‘’]/g, "")
    .trim();
}
function __bankKey(title, options) {
  const titleKey = __normalizeBankText(title);
  const optionKey = Object.values(options || {}).map(__normalizeBankText).sort().join("|");
  return titleKey + "::" + optionKey;
}
function __currentOptionLetters(entry, options) {
  if (!entry) return "";
  const answerTexts = Array.isArray(entry.answerTexts) ? entry.answerTexts : [];
  const current = Object.entries(options || {});
  const letters = [];
  for (const text of answerTexts) {
    const wanted = __normalizeBankText(text);
    const match = current.find(([, optionText]) => __normalizeBankText(optionText) === wanted);
    if (match) letters.push(match[0]);
  }
  return [...new Set(letters)].sort().join("");
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
  const button = tab.playwright.getByText("下一题");
  if (!(await button.isEnabled())) return false;
  await button.click({ timeoutMs: 10000 });
  for (let k = 0; k < 20; k++) {
    await tab.playwright.waitForTimeout(100);
    if (await __body(tab) !== before) return true;
  }
  return false;
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
  const code = browserPrelude(ACTIVE_EXAM, "take") + `
nodeRepl.write(JSON.stringify({ url: await tab.playwright.evaluate(() => location.href), text: await tab.playwright.locator("body").innerText() }, null, 2));
`;
  return bridge.runJs(code, "读取当前浏览器页面", 180000, "take");
}

function actionCollect(bridge) {
  const code = browserPrelude(ACTIVE_EXAM, "take") + COMMON_BROWSER_JS + `
const records = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const before = await __body(tab);
  records.push({ n: n, raw: before });
  if (n < ${TOTAL_QUESTIONS}) await __nextQuestion(tab, before);
}
nodeRepl.write(JSON.stringify(records));
`;
  return bridge.runJs(code, "读取当前考试全部题目", 240000, "take");
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

function actionFill(bridge, answerFile, allowNumericFallback, guess, verify) {
  const numericAnswers = loadAnswers(answerFile);
  const questionBank = loadQuestionBank();
  const code = browserPrelude(ACTIVE_EXAM, "take") + COMMON_BROWSER_JS + `
const numericAnswers = ${JSON.stringify(numericAnswers)};
const questionBank = ${JSON.stringify(questionBank)};
const allowNumericFallback = ${allowNumericFallback ? "true" : "false"};
const guess = ${JSON.stringify(guess || "")};
const verify = ${verify ? "true" : "false"};
const filled = [];
const unknown = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const title = await __questionTitle(tab);
  const questionOptions = await __questionOptions(tab);
  const bankEntry = questionBank[__bankKey(title, questionOptions)] || questionBank["title::" + __normalizeBankText(title)];
  const bankSelection = __currentOptionLetters(bankEntry, questionOptions);
  const numberLetters = allowNumericFallback ? numericAnswers[n] : "";
  const matched = bankSelection || numberLetters;
  let letters = matched || guess;
  let source = bankSelection ? "bank" : (numberLetters ? "number" : (guess ? "guess" : ""));
  const validLetters = [];
  for (const letter of letters) {
    const count = await tab.playwright.getByText(new RegExp("^" + letter + "[.]")).count();
    if (count > 0) validLetters.push(letter);
  }
  letters = validLetters.join("");
  if (!letters && guess) {
    letters = guess;
    source = "guess";
  }
  if (!letters) {
    unknown.push({ n: n, title: title });
  } else {
    let got = await __selectedLetters(tab);
    for (const letter of letters) {
      if (!got.includes(letter)) {
        await tab.playwright.getByText(new RegExp("^" + letter + "[.]")).click({ timeoutMs: 10000 });
        await tab.playwright.waitForTimeout(60);
        got = await __selectedLetters(tab);
      }
    }
    for (const letter of got) {
      if (!letters.includes(letter)) {
        await tab.playwright.getByText(new RegExp("^" + letter + "[.]")).click({ timeoutMs: 10000 });
        await tab.playwright.waitForTimeout(60);
      }
    }
    filled.push({ n: n, title: title, answer: letters, source: source });
  }
  if (n < ${TOTAL_QUESTIONS}) {
    const before = await __body(tab);
    await __nextQuestion(tab, before);
  }
}
const mismatches = [];
if (verify) {
  await __ensureQuestion(tab, 1);
  for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
    const title = await __questionTitle(tab);
    const questionOptions = await __questionOptions(tab);
    const bankEntry = questionBank[__bankKey(title, questionOptions)] || questionBank["title::" + __normalizeBankText(title)];
    const bankSelection = __currentOptionLetters(bankEntry, questionOptions);
    const numberLetters = allowNumericFallback ? numericAnswers[n] : "";
    const letters = bankSelection || numberLetters || guess;
    const got = await __selectedLetters(tab);
    if (letters && got !== letters) mismatches.push({ n: n, title: title, got: got, want: letters });
    if (n < ${TOTAL_QUESTIONS}) {
      const before = await __body(tab);
      await __nextQuestion(tab, before);
    }
  }
}
nodeRepl.write(JSON.stringify({ filled: filled.length, unknown: unknown, mismatches: mismatches, verified: verify, submitted: false }, null, 2));
`;
  return bridge.runJs(code, verify ? "按题干匹配题库并填写答案，不提交" : "快速填写答案，不提交", 600000, "take");
}

function actionVerify(bridge, answerFile, allowNumericFallback) {
  const numericAnswers = loadAnswers(answerFile);
  const questionBank = loadQuestionBank();
  const code = browserPrelude(ACTIVE_EXAM, "take") + COMMON_BROWSER_JS + `
const numericAnswers = ${JSON.stringify(numericAnswers)};
const questionBank = ${JSON.stringify(questionBank)};
const allowNumericFallback = ${allowNumericFallback ? "true" : "false"};
await __ensureQuestion(tab, 1);
const mismatches = [];
const unknown = [];
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const title = await __questionTitle(tab);
  const questionOptions = await __questionOptions(tab);
  const bankEntry = questionBank[__bankKey(title, questionOptions)] || questionBank["title::" + __normalizeBankText(title)];
  const bankSelection = __currentOptionLetters(bankEntry, questionOptions);
  const letters = bankSelection || (allowNumericFallback ? numericAnswers[n] : "");
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
  return bridge.runJs(code, "按题干校验答案", 180000, "take");
}

function actionReview(bridge) {
  const code = browserPrelude(ACTIVE_EXAM, "review") + COMMON_BROWSER_JS + `
const records = [];
await __ensureQuestion(tab, 1);
for (let n = 1; n <= ${TOTAL_QUESTIONS}; n++) {
  const page = await __body(tab);
  const options = await tab.playwright.evaluate(() =>
    [...document.querySelectorAll("li")]
      .filter((node) => /^[A-Z][.]/.test((node.innerText || "").trim()))
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
  return bridge.runJs(code, "读取复盘页全部题目", 240000, "review");
}

function parseReviewRecords(records) {
  return records.map((record) => {
    const lines = record.page.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const qIndex = lines.findIndex((line) => /^\d+、\[1分\]$/.test(line));
    const title = qIndex >= 0 ? (lines[qIndex + 1] || "") : "";
    const correctRaw = (record.page.match(/正确答案[：:]\s*([A-Z][A-Z、,，\s]*)/) || [])[1] || "";
    const yoursRaw = (record.page.match(/(?:你的答案|作答|回答)[：:]\s*([A-Z][A-Z、,，\s]*)/) || [])[1] || "";
    const correct = correctRaw.replace(/[^A-Z]/g, "");
    const yours = yoursRaw.replace(/[^A-Z]/g, "");
    const wrong = /回答错误|答案错误|错误/.test(record.page) || (correct && yours && correct !== yours);
    return { n: record.n, title, key: normalizeTitle(title), correct, yours, wrong, options: record.options };
  });
}

function writeJson(file, data) {
  fs.writeFileSync(path.resolve(file), JSON.stringify(data, null, 2), "utf8");
}

function loadTextConfig(file) {
  const config = {};
  const aliases = {
    account: "account",
    "账号": "account",
    "账户": "account",
    phone: "account",
    "手机号": "account",
    "手机号码": "account",
    "电话号码": "account",
    password: "password",
    "密码": "password",
    examurl: "examUrl",
    "考试网址": "examUrl",
    "考试地址": "examUrl",
    loginurl: "loginUrl",
    "登录网址": "loginUrl",
    "登录地址": "loginUrl",
  };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*\/\/\s*([^=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = aliases[match[1].toLowerCase()] || aliases[match[1]];
    if (!key) continue;
    config[key] = match[2].replace(/\s+$/, "");
  }
  return config;
}

function normalizeExamUrl(value) {
  let input = String(value || "").trim();
  if (!input) return DEFAULT_EXAM;
  if (/^\d+$/.test(input)) {
    const groupId = String(process.env.FZU_GROUP_ID || "").trim();
    if (!groupId) throw new Error("Numeric --exam requires FZU_GROUP_ID; pass a full exam URL instead.");
    return "https://exam.yooc.me/group/" + groupId + "/exam/" + input;
  }
  if (/^exam\.yooc\.me\//i.test(input)) input = "https://" + input;
  if (!/^https?:\/\//i.test(input)) input = "https://exam.yooc.me/" + input.replace(/^\/+/, "");
  return input.replace(/\/(?:take|review)(?:\/.*)?$/i, "").replace(/\/+$/, "");
}

function parseCli(argv) {
  const args = argv.slice(2);
  const action = args.shift() || "auto";
  const parsed = {
    action,
    file: null,
    allowNumberFallback: false,
    guess: "",
    verify: true,
    cdp: process.env.FZU_CDP || "",
    cdpAuto: false,
    browser: "",
    browserPath: process.env.FZU_BROWSER_PATH || "",
    userDataDir: "",
    headless: false,
    standalone: false,
    examUrl: normalizeExamUrl(process.env.FZU_EXAM_URL || DEFAULT_EXAM),
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-number-fallback") {
      parsed.allowNumberFallback = true;
      continue;
    }
    if (arg === "--no-verify") {
      parsed.verify = false;
      continue;
    }
    if (arg === "--cdp") {
      const value = args[++i];
      if (!value) throw new Error("--cdp requires a port or URL");
      parsed.cdp = normalizeCdpEndpoint(value);
      continue;
    }
    if (arg.startsWith("--cdp=")) {
      parsed.cdp = normalizeCdpEndpoint(arg.slice("--cdp=".length));
      continue;
    }
    if (arg === "--cdp-auto") {
      parsed.cdpAuto = true;
      continue;
    }
    if (arg === "--browser" || arg === "--browser-path") {
      const value = args[++i];
      if (!value) throw new Error(arg + " requires a path or 'auto'");
      if (value.toLowerCase() === "auto") parsed.browser = "auto";
      else parsed.browserPath = value;
      continue;
    }
    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length);
      if (value.toLowerCase() === "auto") parsed.browser = "auto";
      else parsed.browserPath = value;
      continue;
    }
    if (arg.startsWith("--browser-path=")) {
      parsed.browserPath = arg.slice("--browser-path=".length);
      continue;
    }
    if (arg === "--user-data-dir") {
      const value = args[++i];
      if (!value) throw new Error("--user-data-dir requires a path");
      parsed.userDataDir = value;
      continue;
    }
    if (arg.startsWith("--user-data-dir=")) {
      parsed.userDataDir = arg.slice("--user-data-dir=".length);
      continue;
    }
    if (arg === "--headless") {
      parsed.headless = true;
      continue;
    }
    if (arg === "--standalone" || arg === "--auto-browser") {
      parsed.standalone = true;
      continue;
    }
    if (arg === "--guess") {
      const value = String(args[++i] || "").trim().toUpperCase();
      if (!/^[A-Z]+$/.test(value)) throw new Error("--guess requires one or more letters A-Z");
      parsed.guess = value;
      continue;
    }
    if (arg.startsWith("--guess=")) {
      const value = arg.slice("--guess=".length).trim().toUpperCase();
      if (!/^[A-Z]+$/.test(value)) throw new Error("--guess requires one or more letters A-Z");
      parsed.guess = value;
      continue;
    }
    if (arg === "--url" || arg === "--exam") {
      const value = args[++i];
      if (!value) throw new Error(arg + " requires a value");
      parsed.examUrl = normalizeExamUrl(value);
      continue;
    }
    if (arg.startsWith("--url=")) {
      parsed.examUrl = normalizeExamUrl(arg.slice("--url=".length));
      continue;
    }
    if (arg.startsWith("--exam=")) {
      parsed.examUrl = normalizeExamUrl(arg.slice("--exam=".length));
      continue;
    }
    if (arg.startsWith("--")) throw new Error("Unknown option: " + arg);
    if (parsed.file) throw new Error("Unexpected extra argument: " + arg);
    parsed.file = arg;
  }
  return parsed;
}

function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || /请填写|在这里填|your[_-]?(account|password)|username|password/i.test(text);
}

function hasConfiguredCredentials(config) {
  return !isPlaceholder(config.account) && !isPlaceholder(config.password);
}

async function pageBodyText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    return "";
  }
}

async function isQuestionPage(page) {
  const body = await pageBodyText(page);
  return /\d+\s*\/\s*\d+/.test(body) && /(?:^|\n)\s*[A-Z][.、]/.test(body);
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() && await locator.isVisible()) return locator;
    } catch {}
  }
  return null;
}

async function clickFirstVisibleText(page, labels) {
  for (const label of labels) {
    const locator = page.getByText(label, { exact: false }).first();
    try {
      if (await locator.count() && await locator.isVisible()) {
        await locator.click({ timeout: 10000 });
        return label;
      }
    } catch {}
  }
  return null;
}

async function fillLoginForm(page, config) {
  const username = await firstVisibleLocator(page, [
    'input[type="text"]:visible',
    'input[type="email"]:visible',
    'input[type="tel"]:visible',
    'input[name*="user" i]:visible',
    'input[id*="user" i]:visible',
    'input[name*="account" i]:visible',
    'input[id*="account" i]:visible',
    'input[name*="login" i]:visible',
    'input[id*="login" i]:visible',
    'input[placeholder*="学号"]:visible',
    'input[placeholder*="账号"]:visible',
    'input[placeholder*="用户名"]:visible',
    'input[placeholder*="手机号"]:visible',
    'input[placeholder*="user" i]:visible',
  ]);
  const password = await firstVisibleLocator(page, [
    'input[type="password"]:visible',
    'input[name*="pass" i]:visible',
    'input[id*="pass" i]:visible',
  ]);
  if (!username || !password) return false;
  if (!hasConfiguredCredentials(config)) {
    throw new Error("检测到登录页，请在脚本末尾填写手机号 phone 和密码 password 后重新运行。");
  }
  await username.fill(String(config.account));
  await password.fill(String(config.password));
  const submit = await firstVisibleLocator(page, [
    '#yooc_submit:visible',
    'button[type="submit"]:visible',
    'input[type="submit"]:visible',
    'input[type="button"]:visible',
  ]);
  if (submit) {
    await submit.click({ timeout: 10000 });
  } else {
    const clicked = await clickFirstVisibleText(page, [
      "登录",
      "登 录",
      "立即登录",
      "统一身份认证登录",
      "账号登录",
      "Sign in",
      "Login",
    ]);
    if (!clicked) await password.press("Enter");
  }
  return true;
}

async function waitForLoginCompletion(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let captchaHinted = false;
  let lastErrorText = "";
  while (Date.now() < deadline) {
    if (await isQuestionPage(page)) return;
    const body = await pageBodyText(page);
    const url = String(page.url() || "");
    const password = await firstVisibleLocator(page, ['input[type="password"]:visible']);
    if (/用户名或密码错误|账号或密码错误|密码错误|账户或密码错误/.test(body)) {
      lastErrorText = "账号或密码错误";
    }
    if (/验证码|captcha|滑块|拖动验证/i.test(body) && !captchaHinted) {
      captchaHinted = true;
      console.log("检测到验证码/滑块。请在打开的浏览器中手动完成，脚本会继续等待。");
    }
    if (!password && url.includes("exam.yooc.me") && !/login|auth|passport|sso/i.test(url)) return;
    if (!password && url.includes("www.yooc.me/mobile/") && !/login|auth|passport|sso/i.test(url) && /首页|课程|课群|我的|yooc/i.test(body)) return;
    if (!password && !/login|auth|passport|sso/i.test(url) && /在线考试|题库|进入考试|开始考试/.test(body)) return;
    await page.waitForTimeout(1000);
  }
  if (lastErrorText) throw new Error("登录失败：" + lastErrorText + "。请检查文件末尾的 phone 和 password。");
  throw new Error("等待登录超时。请确认已手动完成验证码/二次验证。");
}

async function ensureExamReady(bridge, config) {
  await bridge.start();
  const examUrl = normalizeExamUrl(config.examUrl);
  const page = await bridge.getOrCreatePage("take");

  const loginUrl = String(config.loginUrl || "").trim();
  console.log("正在打开考试页...");
  await page.goto(examUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  if (await isQuestionPage(page)) return page;

  if (loginUrl) {
    const password = await firstVisibleLocator(page, ['input[type="password"]:visible']);
    const onLoginPage = Boolean(password) || /login|auth|passport|sso/i.test(page.url());
    if (!onLoginPage && page.url() !== loginUrl) {
      console.log("正在打开移动端登录页...");
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);
      if (await isQuestionPage(page)) return page;
    }
  }

  const filled = await fillLoginForm(page, config);
  if (filled) {
    console.log("已提交登录信息，正在等待网页登录完成...");
    await page.waitForTimeout(800);
    const body = await pageBodyText(page);
    if (/验证码|captcha|滑块|拖动验证/i.test(body)) {
      console.log("检测到验证码/滑块。请在打开的浏览器中手动完成，脚本会继续等待。");
    }
    await waitForLoginCompletion(page, Math.max(30000, Number(config.loginTimeoutMs) || 300000));
  } else if (/login|auth|passport|sso/i.test(page.url())) {
    const clicked = await clickFirstVisibleText(page, ["登录", "统一身份认证登录", "账号登录", "Sign in"]);
    if (clicked) {
      await page.waitForTimeout(1200);
      if (await fillLoginForm(page, config)) {
        console.log("已提交登录信息，正在等待网页登录完成...");
        await waitForLoginCompletion(page, Math.max(30000, Number(config.loginTimeoutMs) || 300000));
      }
    }
  }

  if (!(await isQuestionPage(page))) {
    await page.goto(examUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
  }

  if (!(await isQuestionPage(page))) {
    const entered = await clickFirstVisibleText(page, ["开始考试", "进入考试", "开始答题", "进入答题", "继续答题", "继续考试"]);
    if (entered) console.log("已点击“" + entered + "”，等待题目加载...");
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isQuestionPage(page)) return page;
    await page.waitForTimeout(1000);
  }
  const title = await page.title().catch(() => "");
  throw new Error("没有进入答题页。当前地址：" + page.url() + (title ? "，页面标题：" + title : ""));
}

function waitForEnter() {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.once("close", done);
    rl.question("完成后按 Enter 关闭浏览器... ", () => {
      rl.close();
      done();
    });
  });
}

function usage() {
  console.log(`FZU exam browser helper

Usage:
  node fzu-exam-browser.js auto             # 读取文件末尾手机号和密码，登录并自动填题
  node fzu-exam-browser.js dump [--url <exam-url>]
  node fzu-exam-browser.js collect [questions.json] [--url <exam-url>]
  node fzu-exam-browser.js fill [answer-key.json] [--allow-number-fallback] [--guess <letters>] [--url <exam-url>]
  node fzu-exam-browser.js verify [answer-key.json] [--allow-number-fallback] [--url <exam-url>]
  node fzu-exam-browser.js review [review.json] [--url <exam-url>]
  node fzu-exam-browser.js learn [review.json]
  node fzu-exam-browser.js bank

Options:
  --url <exam-url>             Use a specific exam URL instead of the current/default one.
  --exam <exam-id|url>         Alias for --url. A numeric ID also needs FZU_GROUP_ID.
  --allow-number-fallback      Use answer-key.json by question number when title matching fails.
  --guess <letters>            Optional practice-only fallback; normal fill leaves unknown questions blank.
  --no-verify                  Skip the second full-paper verification pass when speed matters.
  --cdp <port|url>             Attach to an existing Chrome/Edge CDP endpoint, e.g. --cdp 9222.
  --cdp-auto                   Try CDP 9222/9223 first, then launch a local browser.
  --browser <path|auto>        Launch a specified browser, or auto-detect Chrome/Edge/Chromium.
  --browser-path <path>        Alias for --browser <path>.
  --user-data-dir <path>       Persistent browser profile for launched mode.
  --headless                   Launch browser in headless mode.
  --standalone                 Alias for automatic CDP-then-launch mode.

Question matching:
  fill and verify match by normalized title + option text in question-bank-v2.json first.
  Numeric answer-key.json is only used with --allow-number-fallback.

Safety:
  No command ever clicks the submit button.
`);
}

async function main() {
  const cli = parseCli(process.argv);
  if (cli.action === "help" || cli.action === "--help" || cli.action === "-h") return usage();

  ACTIVE_EXAM = cli.examUrl;
  const browserActions = new Set(["auto", "dump", "collect", "fill", "verify", "review"]);
  let bridge = null;
  try {
    if (browserActions.has(cli.action)) {
      if (cli.action === "auto") {
        bridge = new CdpBridge({
          browserPath: cli.browserPath || userConfig.browserPath || detectBrowserExecutable(),
          userDataDir: cli.userDataDir || userConfig.userDataDir || path.join(HERE, ".fzu-oneclick-profile"),
          headless: Boolean(cli.headless),
        });
      } else if (cli.cdp) {
        bridge = new CdpBridge({ endpoint: cli.cdp, userDataDir: cli.userDataDir, headless: cli.headless });
      } else if (cli.browserPath || cli.browser === "auto") {
        bridge = new CdpBridge({ browserPath: cli.browserPath || detectBrowserExecutable(), userDataDir: cli.userDataDir, headless: cli.headless });
      } else if (cli.cdpAuto || cli.standalone) {
        let endpoint = null;
        try { endpoint = await findCdpEndpoint(); } catch {}
        bridge = new CdpBridge({
          endpoint,
          browserPath: endpoint ? null : (cli.browserPath || detectBrowserExecutable()),
          userDataDir: cli.userDataDir,
          headless: cli.headless,
        });
      } else {
        bridge = new NodeReplBridge();
      }
    }

    if (cli.action === "auto") {
      const examUrl = normalizeExamUrl(userConfig.examUrl || DEFAULT_EXAM);
      ACTIVE_EXAM = examUrl;
      console.log("考试地址：" + examUrl);
      await ensureExamReady(bridge, { ...userConfig, examUrl: examUrl });
      console.log("登录完成，开始按题库填写答案（不会自动交卷）...");
      const result = JSON.parse(await actionFill(
        bridge,
        cli.file,
        Boolean(cli.allowNumberFallback || userConfig.allowNumberFallback),
        cli.guess,
        cli.verify && userConfig.verify !== false
      ));
      if (result.unknown && result.unknown.length) {
        writeJson(path.join(HERE, "unknown-questions.json"), result.unknown);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.unknown && result.unknown.length) {
        console.log("未匹配题目 -> " + path.join(HERE, "unknown-questions.json"));
      }
      console.log("填写完成。请检查答案后自行点击“交卷”，脚本不会自动提交。");
      if (userConfig.keepOpen !== false) await waitForEnter();
      return;
    }
    if (cli.action === "dump") {
      console.log(await actionDump(bridge));
      return;
    }
    if (cli.action === "collect") {
      const text = await actionCollect(bridge);
      const records = JSON.parse(text).map((record) => ({ n: record.n, ...parseQuestionRaw(record.raw), raw: record.raw }));
      const out = cli.file || path.join(HERE, "questions.json");
      writeJson(out, records);
      console.log("Collected " + records.length + " questions -> " + path.resolve(out));
      return;
    }
    if (cli.action === "fill") {
      const result = JSON.parse(await actionFill(bridge, cli.file, cli.allowNumberFallback, cli.guess, cli.verify));
      if (result.unknown && result.unknown.length) {
        writeJson(path.join(HERE, "unknown-questions.json"), result.unknown);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.unknown && result.unknown.length) console.log("Unknown questions -> " + path.join(HERE, "unknown-questions.json"));
      return;
    }
    if (cli.action === "verify") {
      console.log(await actionVerify(bridge, cli.file, cli.allowNumberFallback));
      return;
    }
    if (cli.action === "review") {
      const text = await actionReview(bridge);
      const records = parseReviewRecords(JSON.parse(text));
      const out = cli.file || path.join(HERE, "review.json");
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
    if (cli.action === "learn") {
      const file = cli.file ? path.resolve(cli.file) : path.join(HERE, "review.json");
      const records = JSON.parse(fs.readFileSync(file, "utf8"));
      const bank = loadQuestionBank();
      let added = 0, updated = 0;
      for (const record of records) {
        const options = parseRecordOptions(record.options);
        const reviewLetters = String(record.correct || record.answer || "").toUpperCase().replace(/[^A-Z]/g, "");
        const answerTexts = [...reviewLetters].map((letter) => options[letter]).filter(Boolean);
        const key = makeBankKey(record.title || "", options);
        if (!key || !reviewLetters || !answerTexts.length) continue;
        if (bank[key]) updated++;
        else added++;
        bank[key] = {
          title: record.title || bank[key]?.title || "",
          options,
          answerTexts,
          source: path.basename(file),
        };
      }
      saveQuestionBank(bank);
      console.log("Question bank v2 updated: " + Object.keys(bank).length + " questions (+" + added + ", updated " + updated + ") -> " + QUESTION_BANK);
      return;
    }
    if (cli.action === "bank") {
      const bank = loadQuestionBank();
      const legacy = loadLegacyQuestionBank();
      const entries = Object.values(bank);
      const optionTextEntries = entries.filter((entry) => entry.options && Object.keys(entry.options).length).length;
      const titleTextEntries = entries.length - optionTextEntries;
      const uniqueTitles = new Set(entries.map((entry) => normalizeBankText(entry.titleKey || entry.title))).size;
      console.log("Question bank v2: " + entries.length + " entries (" + optionTextEntries + " option-text, " + titleTextEntries + " title-text fallback, " + uniqueTitles + " unique titles) -> " + QUESTION_BANK);
      console.log("Legacy v1 bank: " + Object.keys(legacy).length + " keys -> " + QUESTION_BANK_V1 + " (read-only)");
      return;
    }
    usage();
  } finally {
    if (bridge) bridge.stop();
  }
}

// ============================================================
// 只需要修改下面的配置行，等号后面直接填原文，不要加引号。
// 保存后再次双击“一键考试助手.bat”即可运行。
// ============================================================
// phone=请填写注册认证的手机号码
// password=请填写密码
// loginUrl=https://www.yooc.me/mobile/login
// examUrl=https://exam.yooc.me/group/10683137/exam/596675/take
// ============================================================

const userConfig = {
  account: "请填写手机号",
  password: "请填写密码",
  loginUrl: "https://www.yooc.me/mobile/login",
  examUrl: "https://exam.yooc.me/group/10683137/exam/596675/take",
  ...loadTextConfig(__filename),
  userDataDir: "",
  browserPath: "",
  loginTimeoutMs: 300000,
  allowNumberFallback: false,
  verify: true,
  keepOpen: true,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

