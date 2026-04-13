# Casca 搬遷指南：Netlify → Cloudflare Pages

## 前置條件

- [x] Domain (cascaio.com) 已在 Cloudflare 管理
- [x] GitHub repo 包含所有前端檔案
- [x] Railway 後端正常運作

---

## 第一步：準備 repo 檔案（5 分鐘）

把以下 4 個新檔案加入你的 GitHub repo **根目錄**：

```
your-repo/
├── functions/                    ← 新增
│   ├── api/
│   │   └── [[path]].js          ← API proxy Worker（取代 Netlify proxy）
│   └── health.js                ← /health proxy
├── _redirects                   ← 新增（SPA routing）
├── _headers                     ← 新增（security + cache headers）
├── index.html                   ← 已有
├── terminal.html                ← 已有
├── casca-admin.html             ← 已有
├── casca-dashboard.html         ← 已有
├── casca-annotator.html         ← 已有
├── casca-classifier.js          ← 已有
├── casca-classifier.cjs         ← 已有
├── server-v2.js                 ← 已有（Railway 用）
├── package.json                 ← 已有（Railway 用）
└── netlify.toml                 ← 保留不刪（Netlify 還在跑時需要）
```

這些檔案已經幫你準備好了（在下載的 zip 裡）。

Git commit 並 push：
```bash
git add functions/ _redirects _headers
git commit -m "feat: add Cloudflare Pages config for migration"
git push
```

---

## 第二步：建立 Cloudflare Pages 專案（3 分鐘）

1. 登入 **Cloudflare Dashboard** → 左側選 **Workers & Pages**

2. 點擊 **Create** → 選擇 **Pages** → **Connect to Git**

3. 選擇你的 GitHub 帳號 → 選擇 **casca** repo

4. 設定 Build configuration：
   - **Project name**: `casca`（或任何你想要的名稱）
   - **Production branch**: `main`（或你的主分支名）
   - **Build command**: **留空**（不需要 build）
   - **Build output directory**: **`.`**（根目錄）

5. 點擊 **Save and Deploy**

6. 等待第一次部署完成（約 30-60 秒）

7. 部署完成後你會得到一個臨時 URL，例如：
   `casca-xxx.pages.dev`

---

## 第三步：測試臨時 URL（2 分鐘）

**在切換 DNS 之前先測試一切正常。**

在瀏覽器開啟 `https://casca-xxx.pages.dev`，確認：

- [ ] Landing page 正常顯示
- [ ] `https://casca-xxx.pages.dev/terminal` → Terminal 頁面正常
- [ ] `https://casca-xxx.pages.dev/dashboard` → Dashboard 頁面正常
- [ ] `https://casca-xxx.pages.dev/admin` → Admin 頁面正常
- [ ] `https://casca-xxx.pages.dev/health` → 顯示 Railway 健康檢查 JSON
- [ ] Terminal 登入後送訊息 → 正常收到回覆（API proxy 正常）

> ⚠️ 注意：Supabase Auth 的 redirect URL 可能會擋住在 pages.dev 域名上的登入。
> 如果登入失敗，這是正常的——正式切換到 cascaio.com 後就沒問題。
> 你可以先只確認靜態頁面和 /health 能正常載入。

---

## 第四步：綁定自訂域名（2 分鐘）

1. Cloudflare Pages 專案頁面 → **Custom domains** tab

2. 點擊 **Set up a custom domain**

3. 輸入 `cascaio.com` → **Continue**

4. Cloudflare 會自動偵測到你的 DNS 在同一個帳戶下，
   點擊 **Activate domain**

5. 再次添加 `www.cascaio.com` → **Activate domain**

6. Cloudflare 會自動：
   - 更新 DNS 記錄（CNAME 指向 Pages）
   - 配置 SSL 憑證
   - 完成 DNS 傳播

---

## 第五步：確認 DNS 設定（1 分鐘）

去 **Cloudflare Dashboard → DNS → Records**，確認：

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `cascaio.com` | `casca-xxx.pages.dev` | Proxied ✅ |
| CNAME | `www` | `casca-xxx.pages.dev` | Proxied ✅ |
| CNAME | `api` | `pkak1ctz.up.railway.app` | DNS only ☁️ |

> `api.cascaio.com` 保持 DNS only 指向 Railway，不動它。

---

## 第六步：完整測試（3 分鐘）

等 1-2 分鐘 DNS 生效後，測試：

- [ ] `https://cascaio.com` → Landing page
- [ ] `https://cascaio.com/terminal` → Terminal，登入 + Casca Engine ON + 送訊息
- [ ] `https://cascaio.com/dashboard` → Dashboard，登入 + 查看 API Keys
- [ ] `https://cascaio.com/admin` → Admin Portal，登入 + 查看 Customers
- [ ] `https://cascaio.com/health` → `{"status":"ok",...}`
- [ ] Chrome 無「不安全」警示
- [ ] 手機瀏覽器測試響應式設計

---

## 第七步：停用 Netlify（可選）

確認一切正常後：

1. **Netlify Dashboard** → 你的 casca site → **Domain management**

2. **Remove custom domain** `cascaio.com` 和 `www.cascaio.com`
   （DNS 已經不指向 Netlify 了，這只是清理）

3. 可以保留 Netlify site 作為備份，或直接刪除

---

## 對照表：Netlify vs Cloudflare

| 功能 | Netlify | Cloudflare Pages |
|------|---------|-----------------|
| 靜態部署 | `netlify.toml` [build] | 自動偵測，Build output = `.` |
| SPA Routing | `netlify.toml` [[redirects]] | `_redirects` 檔案 |
| Security Headers | `netlify.toml` [[headers]] | `_headers` 檔案 |
| API Proxy | `status = 200` rewrite | `functions/api/[[path]].js` Worker |
| SSL | Let's Encrypt 自動 | Cloudflare 自動 |
| 部署觸發 | GitHub push | GitHub push |
| 費用 | Free tier 100GB/月 | Free tier 無限頻寬 |

---

## 回滾計畫

如果搬遷後有問題，5 分鐘內回滾：

1. Cloudflare DNS → 把 `cascaio.com` 和 `www` 的 CNAME 改回 `xxx.netlify.app`
2. Netlify 仍然在跑（沒有刪除），立即恢復服務

---

## 注意事項

### Supabase Auth Redirect URLs

如果你在 Supabase Dashboard → Authentication → URL Configuration 設定了
allowed redirect URLs，確保包含：
- `https://cascaio.com/**`
- `https://www.cascaio.com/**`

（這個不論 Netlify 或 Cloudflare 都一樣，應該已經設好了）

### Cloudflare Email Obfuscation

之前造成「不安全」警示的元凶。確認以下設定是**關閉**的：

Cloudflare Dashboard → Security → Settings → **Email Address Obfuscation → OFF**

因為現在用了 Cloudflare Pages（Proxied），Cloudflare 有可能重新注入腳本。

### Railway CORS

Railway 的 `CORS_ORIGIN` 環境變數不需要改。
API proxy Worker 從 Cloudflare 邊緣節點呼叫 Railway，Origin header 會是 `https://cascaio.com`。
你的 server-v2.js 已經支援逗號分隔的多 origin，確認 Railway 環境變數包含：
```
CORS_ORIGIN=https://cascaio.com,https://www.cascaio.com
```

### 每日限額

Cloudflare Workers Free plan: 100,000 requests/day
如果你的 API 呼叫量超過這個數字，需要升級到 Workers Paid ($5/mo)。
