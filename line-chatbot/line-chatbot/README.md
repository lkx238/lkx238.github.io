# LINE Stateless Chat Bot

依 `PLAN.md` 與 `C:\Users\user\LineCHATBOT\spec.txt` 建立的最小可執行架構：只回覆文字、不保存對話記憶、貼圖與其他非文字訊息忽略。

## 架構

- `line-gateway`：Node.js 內建模組實作，不需 npm 套件；驗證 LINE 原始 body 的 HMAC-SHA256 簽章，僅轉送文字與 reply token，移除 user ID，並以事件 ID 做 24 小時去重。
- `n8n`：只綁定 `127.0.0.1:5678`；聊天流程不傳入歷史內容，execution 不保存成功或失敗的 payload。
- `Tailscale Funnel`：只將公開 HTTPS 請求送至 gateway 的 `127.0.0.1:3000`，n8n 編輯器不公開。
- Gemini API：預設採用目前文件列出的 `gemini-3.8-flash`。模型型號、免費層配額與資料處理條件可能變更，部署前請在 AI Studio 確認。

## 啟動本機服務

1. 安裝 Docker Desktop，確認 Docker Engine 已啟動。
2. 複製環境範本並設定加密金鑰：

   ```powershell
   Copy-Item .env.example .env
   $key = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   (Get-Content .env -Raw).Replace('replace-with-a-random-64-character-hex-string', $key) | Set-Content .env
   ```

   你的 Gemini API key 已存入本機 `.env` 的 `GEMINI_API_KEY` 欄位；再設定 LINE Developers Console 的 **Channel secret**。不要提交 `.env`。
3. 啟動服務：

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

4. 在本機開啟 `http://localhost:5678`，完成 n8n 初始管理者帳號設定。
5. 在 n8n 右上角選單匯入 `n8n-workflows/line-inbound.json`。打開兩個 HTTP Request 節點，把 Authentication 設為 **Generic Credential Type → Header Auth**，建立並選取各自的 n8n credential：
   - Gemini：header 名稱 `x-goog-api-key`，值使用 `.env` 中 `GEMINI_API_KEY` 的值。
   - LINE：header 名稱 `Authorization`，值為 `Bearer <LINE channel access token>`。
   - 刪除節點中的 `PASTE_GEMINI_API_KEY_HERE` 與 `Bearer PASTE_LINE_CHANNEL_ACCESS_TOKEN_HERE` 範例 header，改用 credential。金鑰不可直接留在 workflow JSON 或匯出檔。
6. 儲存並啟用 workflow。gateway 的內部 webhook 是 `http://n8n:5678/webhook/line-inbound`。

> 若 n8n image 首次啟動採用最新 `stable` 發行版，匯入時若節點版本提示升級，使用畫面提供的版本更新節點。要可重現部署時，確認可用版本後將 `compose.yaml` 的 `stable` 改成明確版本 tag。

## 階段一：本機整合與安全測試

測試使用偽造 Channel secret 與本機 mock n8n，不會呼叫 LINE 或 Gemini，也不需要真實金鑰：

```powershell
node --test tests/gateway.test.mjs
```

測試涵蓋正確/錯誤簽章、只處理文字、貼圖忽略、移除 user ID、事件去重及 body 大小上限。Compose 結構可用以下指令檢查：

```powershell
docker compose --env-file .env.example config --quiet
```

本機健康檢查：`http://localhost:3000/healthz`。未設定 Channel secret 時 webhook 會回 `503`；簽章錯誤會回 `401`。

## 階段二：LINE + Funnel 端到端測試

需要你自己的 LINE Messaging API channel、Channel secret、Channel access token、Gemini API key，以及已登入 Tailscale 的測試主機；這些外部帳號/金鑰尚未提供，因此本機完成後不能代替你啟用公開 Funnel 或發送真實 LINE 訊息。

1. 在 Tailscale 管理介面啟用 Funnel 權限；確認所用免費方案適用於你的用途（Personal 免費方案只供非商業個人用途）。
2. 在獨立 PowerShell 視窗執行 `tailscale funnel 3000`，保持視窗和電腦運作。CLI 顯示的 `https://<device>.<tailnet>.ts.net` 網址加上 `/line/webhook`，就是 LINE webhook URL。
3. 在 LINE Developers Console 設定 webhook URL，打開 Use webhook，按 Verify。成功後用管理者帳號分別測試文字、貼圖、連續兩次獨立訊息，以及相同事件重送。
4. 確認文字有單次回覆、貼圖無回覆、兩則新訊息互不參照；測試 Gemini 錯誤時是否回固定 fallback。
5. 檢查 `docker compose logs line-gateway n8n` 與 n8n Executions：不應保存訊息內容或 user ID。n8n execution 保存已設為 none；gateway 持久化的去重檔只含事件 ID 與時間戳。

停止公開 Funnel：在 Funnel 視窗按 `Ctrl+C`，或執行 `tailscale funnel reset`。檢查 LINE webhook 停用後再關閉服務。

## 操作

```powershell
docker compose logs -f line-gateway n8n
docker compose down
```

`docker compose down` 保留 volumes。刪除 volumes 會一併移除 n8n 工作流/credential 資料和 gateway 去重資料；執行 `docker compose down -v` 前請先備份。
