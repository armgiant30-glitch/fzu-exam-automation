# FZU Exam Browser Helper

连接 Codex 内置浏览器，读取当前考试题目、按题干匹配答案库、逐题填选并校验。默认不会点击“交卷”。

## 最简单用法（推荐）

1. 双击 `一键考试助手.bat`。
2. 首次运行会自动生成 `fzu-oneclick.local.js`，并用记事本打开；脚本不会自动运行。
3. 拉到文件最末尾，直接在 `// account=` 后面填账号、`// password=` 后面填密码。`// loginUrl=` 已设为 `https://www.yooc.me/mobile/login`；如果需要换考试页，再修改 `// examUrl=`。等号后面不要加引号。
4. 保存并关闭记事本，然后再次双击 `一键考试助手.bat`。
5. 脚本会自动打开浏览器、填写账号密码、进入考试页并按题库填题。遇到验证码或滑块时，在浏览器里手动完成，脚本会继续等待。
6. 填完后请自己检查答案并手动点击“交卷”。脚本不会自动提交。

个人副本 `fzu-oneclick.local.js` 已加入 `.gitignore`，不要把它和账号密码上传到公开仓库。

## 功能

- 修复 Codex 当前浏览器插件的 `browser-service.mjs` 兼容问题
- 修正题目解析中的正则转义错误
- 支持通过 `--url` / `--exam` 指定考试页，不再依赖硬编码考试 ID
- 读取当前考试的 100 道题
- 按“题干 + 选项文本”匹配 `question-bank-v2.json`，选项顺序变化仍可正确定位
- 按题号使用 `answer-key.json` 作为可选回退
- 逐题校验选中结果
- 读取复盘页正确答案，并可合并更新题干答案库
- 全程不自动提交

## 环境

- Windows
- Node.js 18+
- 系统已安装 Chrome 或 Edge（脚本会自动检测）
- 双击模式无需提前打开 Codex 浏览器；会自动打开独立浏览器窗口
- 如果提示缺少 Playwright，请在当前目录运行 `npm install playwright-core`

## 使用

```powershell
# 查看当前页面
node .\fzu-exam-browser.js dump --url "https://exam.yooc.me/group/<group>/exam/<exam>"

# 读取当前考试的全部题目
node .\fzu-exam-browser.js collect questions.json --url "https://exam.yooc.me/group/<group>/exam/<exam>"

# 按题干匹配并填写，不提交
node .\fzu-exam-browser.js fill --url "https://exam.yooc.me/group/<group>/exam/<exam>"

# 逐题校验
node .\fzu-exam-browser.js verify --url "https://exam.yooc.me/group/<group>/exam/<exam>"

# 读取复盘页正确答案
node .\fzu-exam-browser.js review review.json --url "https://exam.yooc.me/group/<group>/exam/<exam>"

# 把复盘结果合并进 question-bank-v2.json
node .\fzu-exam-browser.js learn review.json

# 查看答案库条目数
node .\fzu-exam-browser.js bank
```

也支持考试 ID 形式，但需要先提供课群 ID：

```powershell
$env:FZU_GROUP_ID="10683137"
node .\fzu-exam-browser.js fill --exam 596576
```

## CDP 独立浏览器模式

无需 Codex 内置浏览器时，可以连接已有 Chrome/Edge 的远程调试端口：

1. 启动浏览器并开放 CDP：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="D:\a\chrome-cdp-profile"
```

2. 在该浏览器中登录并打开考试页。

3. 通过 CDP 运行脚本：

```powershell
node .\fzu-exam-browser.js dump --cdp 9222
node .\fzu-exam-browser.js fill --cdp http://127.0.0.1:9222 --url "https://exam.yooc.me/group/<group>/exam/<exam>"
node .\fzu-exam-browser.js fill --cdp-auto
```

脚本会优先匹配 `exam.yooc.me` 页面；`--cdp-auto` 会依次探测 `127.0.0.1:9222` 和 `9223`，找不到时再自动启动本地浏览器。CDP/启动模式依赖本机可用的 Playwright 模块，可通过 `FZU_PLAYWRIGHT_MODULE` 指定路径。

## 无固定浏览器模式

脚本按 WeBan 类似顺序自动选择浏览器：

1. 已有 CDP：`--cdp` / `--cdp-auto`
2. 环境变量或参数指定：`FZU_BROWSER_PATH`、`CHROMIUM_BINARY`、`--browser-path`
3. 自动检测系统 Chrome / Edge / Chromium
4. 最后回退到 Playwright 自带的 Chromium

```powershell
# CDP 优先，找不到就自动启动本地浏览器
node .\fzu-exam-browser.js dump --standalone --headless

# 自动选择系统浏览器并保存登录状态
node .\fzu-exam-browser.js fill --browser auto --user-data-dir "D:\a\fzu-browser-profile"

# 指定任意 Chromium 内核浏览器
node .\fzu-exam-browser.js fill --browser "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir "D:\a\edge-fzu-profile"
```

`--user-data-dir` 会自动持久化登录状态。首次使用建议先打开考试页登录，再运行 `fill`。

## 参数

- `--url <exam-url>`：指定考试地址；可传 take/review 地址，脚本会自动归一化
- `--exam <exam-id|url>`：`--url` 的别名
- `--allow-number-fallback`：题干匹配失败时，才允许按题号使用 `answer-key.json`
- `--guess <letters>`：仅用于刷题库/复盘的进阶模式；默认不开启，普通填写不会使用
- `--no-verify`：需要速度时跳过第二遍全卷校验

## 本次更新

- 新增 `auto` 一键模式：从文件末尾读取账号密码，自动登录、进入考试并填题
- 新增 `一键考试助手.bat`：首次运行自动生成个人副本并用记事本打开
- 自动处理统一登录页、验证码/滑块等待、开始考试按钮和答题页识别
- 已接入 Yooc 移动端登录入口：`https://www.yooc.me/mobile/login`
- v0.2.0 修复了当前 Codex 浏览器插件中 Node REPL 受信服务应使用 `browser-service.mjs` 的问题
- 修复了嵌套模板字符串导致正则转义在运行时丢失的问题
- 增加 `--url` / `--exam` 参数，避免每次修改脚本里的考试地址
- `bank` / `learn` 不再启动浏览器桥
- 新增 `--cdp` / `--cdp-auto`，可直接接管已有 Chrome/Edge 调试实例
- 新增 `--browser` / `--browser-path` / `--standalone`，支持自动检测并启动 Chrome、Edge、Chromium，不再固定浏览器
- 新增 v2 题库：按“题干 + 选项文本”匹配，不保存答案字母，只保存选项文本；已从历史复盘迁移出带完整选项的题目

## 文件

- `一键考试助手.bat`：双击启动入口；首次运行会生成个人副本并打开记事本
- `fzu-exam-browser.js`：主脚本及个人副本模板
- `fzu-oneclick.local.js`：首次运行自动生成的个人副本，已忽略，不会上传账号密码
- `question-bank-v2.json`：按“题干 + 选项文本”保存的 v2 答案库
- `question-bank.json`：旧版按题干字母保存的 legacy 题库，只读参考
- `tools/migrate-v2.mjs`：从复盘记录迁移生成 v2 题库
- `tools/match-v2-unknown.mjs`：用 v2 题库筛出本轮未命中的题目
- `answer-key.json`：按题号保存的可选回退答案

## 安全说明

脚本不包含提交操作，也不会点击“交卷”。题目、答案表和复盘结果仅用于个人学习与自动化研究，请遵守所在课程的考试与学术规范。
