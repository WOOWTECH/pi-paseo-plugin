# 反向代理來源防護

插件後端會拒絕異站 Origin 和瀏覽器跨站 API 請求。代理若先移除 Origin，後端便無法判斷原始來源。Pi 5 的既有 Nginx 代理將 Host 改為 localhost，且清空 Origin；此次部署在 Paseo API 的專用 location 加入來源檢查，再沿用原本的後端轉送設定。

以下是需加入現有 Nginx 配置的片段，不是完整配置。將 `https://pi.example.com` 換成正式 Pi Web origin，包括協定與非預設埠；不要使用任意 Origin 反射或萬用字元。

```nginx
# http context；可放在 conf.d 中的 server 區塊之前。
map $http_origin $pi_paseo_origin_allowed {
    default 0;
    "" 1; # 保留沒有 Origin 的非瀏覽器客戶端。
    "https://pi.example.com" 1;
}

# 加入現有 server；保留 server 的登入保護。
location = /api/plugin-paseo {
    if ($pi_paseo_origin_allowed = 0) {
        add_header Cache-Control "private, no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        return 403;
    }
    if ($http_sec_fetch_site = cross-site) {
        add_header Cache-Control "private, no-store" always;
        add_header Referrer-Policy "no-referrer" always;
        return 403;
    }

    # 將既有 location / 的 proxy_pass、登入／轉送標頭、
    # buffering 及 timeout 設定複製到此處。
}
```

不要只貼上片段後直接重新啟動。先完成 location 的轉送設定，保存原配置並執行 `nginx -t`。Kubernetes 使用 ConfigMap 的 subPath 掛載時，需要重啟 Pod 才會載入更新。

部署後以已有登入的客戶端測試：正式 Origin 與無 Origin 的狀態請求為 200；異站 Origin、`Origin: null` 和 `Sec-Fetch-Site: cross-site` 為 403，拒絕回應包含 `private, no-store` 及 `no-referrer`。另以真正瀏覽器確認設定頁、配對及 Paseo 對話仍正常。此檢查不需要產生或輸出配對連結。

本片段只涵蓋 Paseo API。其他 Pi Web API 及整體代理安全設定仍須依其部署方式維護。
