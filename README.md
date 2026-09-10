# FZU Exam Browser Helper

连接 Codex 内置浏览器，读取当前考试题目、按题干匹配答案库、逐题填选并校验。默认不会点击“交卷”。

## 功能

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
node .\fzu-exam-browser.js dump

# 读取当前考试的全部题目
node .\fzu-exam-browser.js collect

# 按题干匹配并填写，不提交
node .\fzu-exam-browser.js fill

# 逐题校验
node .\fzu-exam-browser.js verify

# 读取复盘页正确答案
node .\fzu-exam-browser.js review

# 把复盘结果合并进 question-bank.json
node .\fzu-exam-browser.js learn

# 查看答案库条目数
node .\fzu-exam-browser.js bank
```

## 文件

- `fzu-exam-browser.js`：主脚本
- `question-bank.json`：按题干保存的答案库
- `answer-key.json`：按题号保存的可选回退答案

## 安全说明

脚本不包含提交操作，也不会点击“交卷”。题目、答案表和复盘结果仅用于个人学习与自动化研究，请遵守所在课程的考试与学术规范。
