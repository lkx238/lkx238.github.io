# LINE 聊天機器人規劃（草案）

> 已讀取 `C:\Users\user\LineCHATBOT\spec.txt`：目標是簡單的 LINE 聊天機器人，不保留記憶，每次對話都像剛認識；只回覆文字，貼圖不回覆。以下方案依此規格調整。知識範圍尚未指定，因此第一版採一般友善對話，不臆測特定業務資訊。

## 目標與假設

- 建立繁體中文 LINE 官方帳號聊天機器人，n8n 負責流程編排，模型使用雲端 API；每次收到訊息均為獨立請求，不傳入或儲存先前對話。
- 僅處理使用者傳來的文字訊息。貼圖、圖片、音訊等非文字訊息忽略，不回覆。
- 開發與小規模試用先以免費額度為目標；免費方案有配額、使用條款、資料處理與服務可用性限制，不能承諾正式營運永久零成本。
- 「Funnel」先按 **Tailscale Funnel** 解讀：暫時公開本機 webhook，以便 LINE 平台回呼。主機需要持續開機、連網且執行 Tailscale 和 Docker。
- 如本機環境是 Windows，先以 Docker Desktop + WSL2 執行 Compose；Tailscale Funnel 對外轉送至本機服務埠。

## 建議架構

```text
LINE 使用者
  │ 訊息
  ▼
LINE Platform ──HTTPS webhook──▶ Tailscale Funnel
                                      │ 僅公開 webhook gateway
                                      ▼
                             Webhook gateway
                             驗證簽章、只取文字事件、去重
                                      │ Docker 私有網路
                                      ▼
                                    n8n
                       單次文字 → 呼叫模型（無歷史記憶）
                                      │
                      LINE Reply API ◀┴──▶ Gemini API
```

### 元件與責任

1. **LINE Official Account / Messaging API**：建立開發用帳號及 Messaging API channel，設定 webhook；正式計畫和可用訊息量依台灣帳號後台為準。LINE 的 Reply API 不計入訊息方案的月訊息數，但 push 等方式會計數，仍以官方規則為準。
2. **Docker Compose**：啟動 n8n 與輕量 webhook gateway。資料用 named volume 保存；密鑰放在 `.env`（不提交版本控制），對外只映射 gateway 所需埠，n8n 編輯介面只供本機使用。
3. **Webhook gateway（小型 Node.js 服務）**：以原始 request body 驗證 `x-line-signature` 的 HMAC-SHA256，再將合法事件轉送到 n8n 內部 webhook。只靠 n8n 收到已解析 JSON 再驗簽容易改變原始 body；LINE 要求在任何解析或修改前使用原始 body 驗簽。Gateway 同時忽略非文字事件、處理重複事件並限制 body 大小。
4. **Tailscale Funnel**：把 gateway 的本機埠公開成 HTTPS URL；LINE webhook 指向 Funnel URL 加上 gateway 路徑。不要公開 n8n 編輯器或資料庫。Funnel 網址供公網存取，故 webhook 必須驗簽，並避免在 log 留存訊息全文與個資。
5. **n8n 工作流**：接收 gateway 傳入的合法文字事件 → 檢查事件類型與 `replyToken` → 只把當次文字交給雲端模型（不串接歷史、不寫入聊天記憶）→ 檢查輸出長度與安全條件 → 以 HTTP Request 呼叫 LINE Reply API → 將錯誤寫入不含敏感內容的記錄。非文字事件由 gateway 忽略，不回覆。
6. **雲端模型**：開發初期可評估 Google Gemini API 的免費層。API 免費層模型、配額與速率會變動；免費層資料可能用於改善服務，因此不得送入密碼、身分證、付款、健康或其他敏感資料。加入用量上限、短輸出、速率限制與模型失敗時的固定回覆。

## 免費資源與限制

| 項目 | 開發階段免費選項 | 主要限制 |
|---|---|---|
| 流程平台 | 自架 n8n Community Edition | 需要自行維護、備份與更新；須遵守 n8n 授權條款 |
| 容器 | Docker Desktop + Compose（個人/小型使用情境） | Docker Desktop 的免費資格依使用者/組織類型而異；企業用途先核對授權 |
| 公網 webhook | Tailscale Funnel Personal | 官方免費 Personal 方案限非商業個人使用；Funnel 有流量限制。商業用途需先核對方案或改用合規的免費公開隧道/主機 |
| 模型 API | Gemini API 免費層 | 依模型有速率與用量限制，免費層資料處理條件與付費層不同；不適合敏感資料或 SLA 需求 |
| LINE | LINE Official Account + Messaging API | 台灣方案、免費訊息額度和價格將於 2026-11-01 調整；確認帳號後台當期條件。Reply API 與 push 類訊息計費方式不同 |
| 主機 | 現有 Windows/Linux 電腦 | 沒有免費託管 SLA；關機、睡眠、斷網或更新會使 webhook 中斷 |

若機器人會用於商業服務，不能直接假設 Tailscale Personal 免費方案符合使用條款；應先確認商用資格，再選 Funnel 或替代隧道方案。若必須保持 24/7，家用主機免費方案無法保證可用性。

## n8n 工作流規劃

### Workflow A：LINE inbound / answer

`Webhook (gateway internal) → IF (message event?) → Normalize fields → Optional FAQ lookup → HTTP Request (Gemini) → Validate/fallback → HTTP Request (LINE Reply API)`

- 最小資料欄位：當次文字、`replyToken`、`webhookEventId`（短期去重用）；不收集 `userId`，不建立歷史對話或持久化訊息內容。
- 對模型設定明確角色、可回答範圍、繁體中文、字數上限及「未知時承認不知道」規則。
- 不提供對話記憶或多輪上下文。第一版為簡單一般對話，不自行推測未提供的業務資訊；收到貼圖、圖片或其他非文字內容時不回覆。
- API timeout、429、無效輸出或 Reply API 失敗時，回覆簡短固定訊息並記錄錯誤代碼；不要無限制重試已過期的 replyToken。
- 做去重，避免 LINE 重送同一 webhook 時產生多次模型呼叫或回覆。

### Workflow B：健康檢查與錯誤觀測

- 每次部署後確認 gateway、n8n health endpoint、webhook 和模型連線狀態。
- n8n execution 留存時間設短，停用不必要的成功執行資料保存；錯誤記錄遮罩 token、channel secret、完整使用者訊息。
- 定期匯出 workflow JSON 並備份 n8n 加密金鑰與資料 volume；備份檔不得放入公開 repo。

## 兩階段測試計畫

### 第一階段：本機整合與安全測試（不依賴真實 LINE 使用者）

**範圍**：Compose 啟動、gateway 驗簽、內網轉送、n8n 工作流、模型呼叫與 LINE API 請求格式。

**步驟**

1. 以 Docker Compose 啟動 gateway + n8n，確認資料 volume、健康狀態和 n8n 管理頁僅本機可訪問。
2. 用測試腳本/HTTP client 傳送正確簽章的測試 webhook，確認 gateway 驗簽通過並觸發 n8n；再測缺少簽章、錯誤簽章、空事件、文字/貼圖事件、重送事件和過大 body。
3. 對 n8n 模型節點使用測試 API key，以常見問題、超長輸入、空白文字、提示注入、模型 429/timeout 情境驗證回覆與 fallback。
4. LINE API 使用 mock endpoint 或測試環境，確認 Bearer token、replyToken、JSON 格式、錯誤碼處理；不要在此階段對真實好友推播。

**通過條件**

- 只有正確簽章的事件可進入 n8n；重送不造成重複回答。
- 模型正常時回覆符合繁體中文和字數限制；失敗時在設定的 timeout 內返回固定提示。
- log、執行紀錄、Git 中均找不到 API key、channel secret 或不必要的個資。
- n8n 管理介面無公網路徑。

### 第二階段：LINE + Funnel 端到端試用

**範圍**：LINE 測試帳號、真實 webhook、Tailscale Funnel HTTPS、Reply API。

**步驟**

1. 啟用 Funnel，將公開 HTTPS URL 指向 gateway，不直接指向 n8n；將該 URL 設為 LINE webhook，於 LINE Developers Console 執行 Verify。
2. 使用管理者/少量內部測試帳號做文字問答、空訊息、超長文字、貼圖和其他非文字事件、同一事件重送和短時間多次訊息測試；確認每一則文字請求都不受先前對話影響，貼圖不產生回覆。
3. 關閉或模擬模型 API 限流/失敗，確認 fallback；檢查 LINE 對 replyToken 時效與錯誤處理。
4. 觀察 1–3 天：成功率、回覆延遲、429、Docker 重啟、主機休眠，以及 LINE 帳號月訊息額度。確認商用前重新核對 Tailscale 與 LINE 當期條款。

**通過條件**

- LINE webhook Verify 成功，測試訊息可收可回；無效簽章被拒絕。
- 小規模試用中無重複回覆，模型及 LINE API 失敗都有可見但不洩密的錯誤記錄。
- 主機重啟後服務可恢復，workflow 與加密憑證能從備份還原。
- 若需要商業或 24/7 上線，先完成付費/合規託管方案評估，再將第二階段視為正式上線。

## 待規格確認

1. 除一般簡單聊天外，是否有特定主題或需要禁止回答的內容？
2. 個人專案還是商業服務？是否要 24/7、預估好友數與每月對話量？
3. 允許模型處理哪些資料？是否有人工客服轉接需求？

## 官方參考

- [LINE：驗證 webhook 簽章](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [LINE：Messaging API 訊息計價規則](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [LINE 台灣官方帳號方案](https://tw.linebiz.com/service/account-solutions/line-official-account/)
- [Tailscale Funnel 文件](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale 方案與免費資格](https://tailscale.com/pricing)
- [n8n：Docker Compose 部署](https://docs.n8n.io/deploy/host-n8n/install-options/use-a-cloud-provider/use-docker-compose/)
- [Gemini API：價格與免費層](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API：速率限制](https://ai.google.dev/gemini-api/docs/rate-limits)
