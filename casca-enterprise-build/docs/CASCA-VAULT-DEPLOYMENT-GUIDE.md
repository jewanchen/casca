# Casca Vault — 部署手冊

> 給 IT 人員的完整安裝與操作指南

---

## 目錄

1. [前置需求](#1-前置需求)
2. [取得部署包](#2-取得部署包)
3. [安裝部署](#3-安裝部署)
4. [驗證安裝](#4-驗證安裝)
5. [整合你的應用程式](#5-整合你的應用程式)
6. [管理與維運](#6-管理與維運)
7. [離線部署（Air-gapped）](#7-離線部署air-gapped)
8. [故障排除](#8-故障排除)
9. [更新升級](#9-更新升級)
10. [安全注意事項](#10-安全注意事項)

---

## 1. 前置需求

### 硬體需求

| 項目 | 最低需求 | 建議配置（500 QPS） |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 50 GB SSD | 100 GB SSD |
| Network | 10 Mbps | 100 Mbps |
| GPU | 不需要 | 不需要 |

### 軟體需求

- **Docker** 24.0+
- **Docker Compose** v2.20+
- **作業系統**：Ubuntu 22.04+、CentOS 8+、Debian 12+、macOS 13+

### 網路需求

| 連線 | 方向 | 用途 | 必要？ |
|---|---|---|---|
| 你的 App → Casca Vault (port 3001) | 內網 | API 請求 | ✅ |
| Casca Vault → OpenAI/Anthropic/Google | 外網 | LLM 呼叫 | ✅ |
| Casca Agent → Casca Cloud (HTTPS) | 外網 | 授權驗證 + 用量回報 | ⭕ 離線可免 |

### 你需要準備的

- [ ] **Casca License Key**（向 Casca 業務取得，格式：`ent_xxxxxxxx`）
- [ ] **LLM API Key**（至少一組：OpenAI `sk-xxx` 或 Anthropic `sk-ant-xxx` 或 Google `AIza...`）

---

## 2. 取得部署包

Casca 會提供一個 zip 檔案，包含：

```
casca-vault-v1.0.0/
├── docker-compose.enterprise.yml    ← 部署檔案
├── .env.example                     ← 設定範本
├── init-db.sql                      ← 資料庫初始化
├── README.md                        ← 快速指南
└── license.json                     ← 離線授權（如適用）
```

Docker images 會在首次啟動時自動下載。

---

## 3. 安裝部署

### Step 1：解壓縮

```bash
unzip casca-vault-v1.0.0.zip
cd casca-vault-v1.0.0
```

### Step 2：設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`：

```bash
# ═══ 必填 ═══

# Casca 授權金鑰（向 Casca 取得）
CASCA_LICENSE_KEY=ent_你的授權碼

# 管理密鑰（自行設定一組強密碼）
ADMIN_SECRET=這裡放一個32位以上的隨機字串

# 資料庫密碼（自行設定）
DB_PASSWORD=這裡放一個強密碼

# ═══ 選填 ═══

# API 監聽 port（預設 3001）
ENGINE_PORT=3001

# CORS（設定你的前端 domain，多個用逗號分隔）
CORS_ORIGIN=https://your-app.com

# LLM 逾時（毫秒）
LLM_TIMEOUT_MS=30000

# Agent 自動更新（預設 false）
AUTO_UPDATE=false
```

### Step 3：啟動所有服務

```bash
docker compose -f docker-compose.enterprise.yml up -d
```

首次啟動會下載 Docker images（約 500MB），需要 2-5 分鐘。

### Step 4：確認所有服務正常

```bash
docker compose -f docker-compose.enterprise.yml ps
```

你應該看到 4 個服務全部 `running` 或 `healthy`：

```
NAME              STATUS           PORTS
casca-engine      Up (healthy)     0.0.0.0:3001->3001/tcp
casca-minilm      Up (healthy)     8000/tcp
casca-agent       Up               
db                Up (healthy)     5432/tcp
```

---

## 4. 驗證安裝

### 健康檢查

```bash
curl http://localhost:3001/health
```

預期回應：
```json
{
  "status": "ok",
  "providers": 2,
  "stripe_enabled": false,
  "timestamp": "2026-04-24T..."
}
```

### 送一筆測試請求

```bash
curl -X POST http://localhost:3001/api/v1/chat/completions \
  -H "Authorization: Bearer sk-你的OpenAI_Key" \
  -H "X-Casca-Key: ent_你的授權碼" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What is an API?"}]
  }'
```

預期回應：一個 OpenAI 格式的 JSON，額外包含 `_casca` 欄位：

```json
{
  "choices": [{ "message": { "content": "An API is..." } }],
  "_casca": {
    "cx": "LOW",
    "model": "gpt-4o-mini",
    "savingsPct": 97,
    "latencyMs": 15,
    "rule": "R1: 查詢/定義 → LOW"
  }
}
```

✅ 看到 `cx: "LOW"` 和 `savingsPct: 97` 就表示 Casca Vault 已經在幫你省錢了。

---

## 5. 整合你的應用程式

### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的OpenAI_Key",
    base_url="http://casca-vault-host:3001/v1",
    default_headers={"X-Casca-Key": "ent_你的授權碼"}
)

response = client.chat.completions.create(
    model="auto",  # Casca 會自動選最佳模型
    messages=[{"role": "user", "content": "幫我寫一段 Python 的 Hello World"}]
)
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-你的OpenAI_Key',
  baseURL: 'http://casca-vault-host:3001/v1',
  defaultHeaders: { 'X-Casca-Key': 'ent_你的授權碼' },
});

const res = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'What is machine learning?' }],
});
console.log(res.choices[0].message.content);
```

### cURL

```bash
curl -X POST http://casca-vault-host:3001/api/v1/chat/completions \
  -H "Authorization: Bearer sk-你的OpenAI_Key" \
  -H "X-Casca-Key: ent_你的授權碼" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

### 重點

- `base_url` 指向你的 Casca Vault 伺服器
- `Authorization` 帶你自己的 LLM API Key
- `X-Casca-Key` 帶 Casca 授權碼
- `model` 設 `"auto"` 讓 Casca 自動選擇，或指定 `"gpt-4o"` 等

---

## 6. 管理與維運

### 查看服務日誌

```bash
# 所有服務
docker compose -f docker-compose.enterprise.yml logs -f

# 只看 Engine
docker compose -f docker-compose.enterprise.yml logs -f casca-engine

# 只看 Agent
docker compose -f docker-compose.enterprise.yml logs -f casca-agent
```

### 重啟服務

```bash
# 重啟全部
docker compose -f docker-compose.enterprise.yml restart

# 只重啟 Engine
docker compose -f docker-compose.enterprise.yml restart casca-engine
```

### 停止 / 啟動

```bash
# 停止（保留資料）
docker compose -f docker-compose.enterprise.yml stop

# 啟動
docker compose -f docker-compose.enterprise.yml start

# 完全移除（⚠ 會刪除資料庫）
docker compose -f docker-compose.enterprise.yml down -v
```

### 查看用量

Agent 每小時自動向 Casca Cloud 回報用量。你也可以直接查本地資料庫：

```bash
docker compose -f docker-compose.enterprise.yml exec db \
  psql -U casca -c "SELECT cx, COUNT(*), SUM(tokens_in+tokens_out) as tokens FROM api_logs GROUP BY cx;"
```

---

## 7. 離線部署（Air-gapped）

適用於完全無法連接外部網路的環境（金融機房、政府機關）。

### Step 1：取得離線授權

向 Casca 管理員申請離線 license.json 檔案。

### Step 2：放置授權檔

```bash
cp license.json ./casca-agent/license.json
```

### Step 3：修改 .env

```bash
# 清空 Cloud URL（不連線）
CASCA_CLOUD_URL=
```

### Step 4：離線載入 Docker Images

在有網路的機器上先下載：
```bash
docker save casca-enterprise-engine:latest | gzip > casca-engine.tar.gz
docker save casca-enterprise-minilm:latest | gzip > casca-minilm.tar.gz
docker save casca-enterprise-agent:latest | gzip > casca-agent.tar.gz
docker save postgres:16-alpine | gzip > postgres.tar.gz
```

搬到離線機器後載入：
```bash
docker load < casca-engine.tar.gz
docker load < casca-minilm.tar.gz
docker load < casca-agent.tar.gz
docker load < postgres.tar.gz
```

### Step 5：啟動

```bash
docker compose -f docker-compose.enterprise.yml up -d
```

### 離線限制

- 📊 用量回報：不會自動送出（儲存在本地 DB，合約以固定量計費）
- 📦 更新：需手動取得更新包並載入
- 🔐 授權：使用離線 license.json，有到期日，需定期換新

---

## 8. 故障排除

### 問題：Engine 無法啟動

```bash
docker compose logs casca-engine | tail -20
```

常見原因：
- **License 失效**：檢查 `.cache/license.invalid` 是否存在
- **DB 連線失敗**：確認 PostgreSQL 容器是否健康
- **Port 被佔用**：`lsof -i :3001`

### 問題：分類結果全部是 MED

原因：MiniLM 服務未啟動或連線失敗。

```bash
# 檢查 MiniLM 健康
curl http://localhost:8000/health

# 如果失敗，重啟
docker compose restart casca-minilm
```

### 問題：LLM 回應超時

調整 .env：
```bash
LLM_TIMEOUT_MS=60000  # 增加到 60 秒
```

然後重啟 Engine：
```bash
docker compose restart casca-engine
```

### 問題：Agent 授權失敗

```bash
# 檢查 Agent 日誌
docker compose logs casca-agent | grep -i license

# 手動驗證
docker compose exec casca-agent node agent.js --validate-only
```

---

## 9. 更新升級

### 自動更新（需外網連線）

Agent 每 6 小時檢查更新。如果 `.env` 設定了 `AUTO_UPDATE=true`，會自動下載並套用。

### 手動更新

1. 從 Casca 取得新版本的 Docker images
2. 載入新 images：
   ```bash
   docker load < casca-engine-v1.1.0.tar.gz
   ```
3. 更新 docker-compose.yml 的 image tag
4. 重新啟動：
   ```bash
   docker compose -f docker-compose.enterprise.yml up -d
   ```

### Rollback

如果更新後有問題：
```bash
# 切回舊版 image
docker compose -f docker-compose.enterprise.yml down
# 修改 image tag 回舊版
docker compose -f docker-compose.enterprise.yml up -d
```

資料庫不受影響，Rollback 只影響程式碼。

---

## 10. 安全注意事項

### 網路

- ✅ Casca Vault 只需要內網 port 3001 對你的 App 開放
- ✅ MiniLM（port 8000）和 PostgreSQL（port 5432）不要對外開放
- ✅ Agent 對 Casca Cloud 走 HTTPS（TLS 1.3）

### 憑證

- ✅ `ADMIN_SECRET` 和 `DB_PASSWORD` 使用 32 位以上隨機字串
- ✅ `.env` 檔案權限設為 `600`（只有 owner 可讀）
- ✅ 你的 LLM API Key 在每次請求中帶入，Casca Vault **不儲存**

### 資料

- ✅ Prompt 原文**不會存在任何 log 中**（api_logs 只存 token 數和分類結果）
- ✅ Agent 回報給 Casca Cloud 的只有**聚合用量數字**（token 總數、請求數），不含任何內容
- ✅ 離線授權使用 RSA-4096 數位簽章，無法偽造

### 定期動作

- 📅 **每季**：更新 `ADMIN_SECRET`
- 📅 **每年**：續約 License Key
- 📅 **每月**：檢查 Docker image 安全更新

---

## 聯繫支援

- **Email**：support@cascaio.com
- **緊急**：Casca 管理員 Slack channel
- **文件**：https://cascaio.com/docs/vault

---

*Casca Vault v1.0.0 · © 2026 Vast Intelligence Limited*
