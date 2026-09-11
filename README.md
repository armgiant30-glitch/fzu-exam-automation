# FZU Exam Browser Helper

连接 Codex 内置浏览器，读取当前考试题目、按题干匹配答案库、逐题填选并校验。默认不会点击“交卷”。

## 功能

- 修复 Codex 当前浏览器插件的 `browser-service.mjs` 兼容问题
- 修正题目解析中的正则转义错误
- 支持通过 `--url` / `--exam` 指定考试页，不再依赖硬编码考试 ID
- 读取当前考试的 100 道题
- 按题干匹配 `question-bank.json`，题序变化不受影响
- 按题号使用 `answer-key.json` 作为可选回退
- 逐题校验选中结果
- 读取复盘页正确答案，并可合并更新题干答案库
- 全程不自动提交

## 环境

- Windows
- Codex Desktop
- Codex 内置浏览器已打开目标考试页
- Node.js

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

# 把复盘结果合并进 question-bank.json
node .\fzu-exam-browser.js learn review.json

# 查看答案库条目数
node .\fzu-exam-browser.js bank
```

也支持考试 ID 形式，但需要先提供课群 ID：

```powershell
$env:FZU_GROUP_ID="10683137"
node .\fzu-exam-browser.js fill --exam 596576
```

## 参数

- `--url <exam-url>`：指定考试地址；可传 take/review 地址，脚本会自动归一化
- `--exam <exam-id|url>`：`--url` 的别名
- `--allow-number-fallback`：题干匹配失败时，才允许按题号使用 `answer-key.json`

## 本次更新

- v0.2.0 修复了当前 Codex 浏览器插件中 Node REPL 受信服务应使用 `browser-service.mjs` 的问题
- 修复了嵌套模板字符串导致正则转义在运行时丢失的问题
- 增加 `--url` / `--exam` 参数，避免每次修改脚本里的考试地址
- `bank` / `learn` 不再启动浏览器桥
- 已将 `question-bank.json` 扩充到 182 条题干答案

## 文件

- `fzu-exam-browser.js`：主脚本
- `question-bank.json`：按题干保存的答案库
- `answer-key.json`：按题号保存的可选回退答案

## 安全说明

脚本不包含提交操作，也不会点击“交卷”。题目、答案表和复盘结果仅用于个人学习与自动化研究，请遵守所在课程的考试与学术规范。
