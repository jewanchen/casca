# Casca Zapier 上架操作指南

## 總覽

| 項目 | 說明 |
|------|------|
| 難度 | ★★☆☆☆（比 Salesforce 簡單 10 倍）|
| 時間 | 開發 1 天 → 審查 1 週 → Beta 90 天 → 正式上架 |
| 費用 | 完全免費 |
| 審查 | 只審 UX 和 API 品質，沒有安全掃描 |

---

## Step 1：註冊 Zapier Developer（5 分鐘）

1. 前往 https://zapier.com/app/developer
2. 用你的 Zapier 帳號登入（沒有的話免費註冊）
3. 你現在可以建立 integration 了

---

## Step 2：安裝 Zapier CLI（5 分鐘）

```bash
# 安裝 Zapier Platform CLI
npm install -g zapier-platform-cli

# 登入
zapier login

# 驗證
zapier whoami
```

---

## Step 3：初始化專案（2 分鐘）

```bash
# 進入我們提供的專案目錄
cd casca-zapier

# 安裝依賴
npm install

# 註冊 Integration（第一次才需要）
zapier register "Casca AI Router"
```

> 註冊後 Zapier 會給你一個 Integration ID，記下來。

---

## Step 4：部署 server-v2.js Zapier 端點（10 分鐘）

把更新過的 `server-v2.js` push 到 Railway：

```bash
# 在你的 casca 主 repo
git add server-v2.js
git commit -m "feat: add Zapier integration endpoints"
git push
```

等 Railway 自動部署完成（~30 秒），然後驗證：

```bash
# 測試 auth endpoint
curl -H "Authorization: Bearer csk_YOUR_KEY" https://api.cascaio.com/api/zapier/auth-test

# 測試 chat endpoint
curl -X POST -H "Authorization: Bearer csk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello from Zapier!"}' \
  https://api.cascaio.com/api/zapier/chat
```

---

## Step 5：Push Integration 到 Zapier（2 分鐘）

```bash
cd casca-zapier
zapier push
```

這會上傳你的 integration 程式碼到 Zapier 的伺服器。

---

## Step 6：在 Zapier 測試（15 分鐘）

1. 前往 https://zapier.com/app/editor
2. 建立一個新 Zap
3. Trigger 選任何 app（如 Gmail → New Email）
4. Action 搜尋 "Casca" → 選 "AI Chat"
5. 輸入 API Key 連接
6. 設定 prompt = "Summarize: {{email body}}"
7. 測試 → 確認收到 AI 回應

重複測試每個 trigger 和 action：
- [ ] AI Chat
- [ ] Summarize Text
- [ ] Translate Text
- [ ] Generate SOQL
- [ ] New API Request (trigger)
- [ ] New Annotation (trigger)
- [ ] Usage Alert (trigger)
- [ ] Find Usage Stats (search)

---

## Step 7：邀請 Beta 用戶（ongoing）

```bash
# 取得邀請連結
zapier users:links
```

把連結分享給你的早期用戶。他們接受邀請後就能在 Zap Editor 裡使用 Casca。

---

## Step 8：提交審查（5 分鐘）

1. 前往 https://zapier.com/app/developer → 你的 Integration
2. 點 "Visibility" → "Submit for Review"
3. 填寫：
   - App Category: AI Tools / Productivity
   - App Description: (用 README 的文案)
   - App Logo: 上傳 256x256 PNG
   - Homepage URL: https://cascaio.com
   - API Docs URL: https://cascaio.com/docs/salesforce

4. 提交後等待 ≤ 1 週審查

---

## Step 9：審查通過 → Public Beta

審查通過後：
- App 狀態變為 **Beta**
- 出現在 Zapier 的 App Directory（帶 Beta 標籤）
- 任何 Zapier 用戶都能搜到和使用

### Beta 期間要做的事：

1. **建立 10 個 Zap Templates**
   - 用 ZAP_TEMPLATES.md 裡的 10 個範例
   - 在 Zapier Developer Dashboard → Zap Templates 建立
   - 每個 template 需要一個實際可運行的 Zap

2. **累積 50 個活躍用戶**
   - 活躍 = 用戶有一個使用 Casca 的 Zap 且 Zap 是開啟的
   - 在官網、社群、email campaign 推廣
   - 90 天內達標

3. **發佈幫助文件**
   - cascaio.com/docs/zapier（用 README 的內容）

---

## Step 10：正式上架

Zapier 每日自動檢查：
- 10 個 Zap Templates ✓
- 50 個活躍用戶 ✓
- 達標後自動移除 Beta 標籤
- 收到上架確認 email
- 正式進入 Zapier Partner Program

---

## 常見問題

**Q: Zapier 會做安全審查嗎？**
A: 不會。Zapier 只審 UX 品質（欄位命名、描述、sample data）和 API 穩定性。沒有 Checkmarx、沒有 Pentest。

**Q: Zapier 抽成嗎？**
A: 不抽成。用戶付費給 Zapier 是 Zap 的執行費用。你的 Casca 計費完全獨立。

**Q: 可以同時跑 Salesforce AppExchange 和 Zapier 嗎？**
A: 可以。兩個完全獨立。同一個 api.cascaio.com 同一個 API Key。

**Q: 50 個用戶很難達到嗎？**
A: 如果你在官網嵌入 Zapier integration 連結（behind login screen），Zapier 可以 waive 這個要求。
