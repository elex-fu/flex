# Hosted Web 部署

`pnpm --filter @flyx/mvp-web build` 生成静态 `dist/`。使用 HTTPS origin 托管，保留构建输出中的 `_headers` 规则；Cloudflare Pages、Netlify 等支持该格式。其他服务器需将同样规则配置为响应头，不能仅把 `_headers` 当作普通文件上传。

入口 `/#offer=…` 会在启动时同步清理地址栏，然后验证有效期、协议范围和 Host 指纹。Relay 的配对、认证、bootstrap、snapshot、Timeline、Diff 和设备操作全部经由 client-core 的加密 RPC，不要求 Host HTTP API 可达。页面不加载第三方脚本、字体、分析服务或二维码服务；二维码使用本地 Host 的图片响应，不插入 SVG HTML。

生产 CSP 禁止内联脚本、eval、对象、iframe 嵌入和 Trusted Types HTML 注入。`connect-src https: wss:` 允许用户导入不同的 HTTPS Host 和 WSS Relay；实际连接仍受 client-core 的 URL 校验和固定 Host 身份约束。固定 Relay 部署可将这两个 scheme source 收紧为运营方和允许的 Host 精确 origin。不要加入 `unsafe-inline`、`unsafe-eval` 或生产 `ws:` 例外。开发时 Vite 的 HMR 与显式 loopback HTTP 使用独立开发配置。

浏览器短期 Relay 凭据可能存于本地设备存储，静态设备密钥仅保留在当前页面内存中；界面明确显示其不具备硬件保护。Direct 浏览器会话使用 HttpOnly cookie。设备丢失后，可从另一台拥有 `access:admin` 的设备撤销；退出配对会撤销本设备的服务端授权并关闭活动连接。

升级发布时先更新带内容 hash 的 assets，最后更新 `index.html`。HTML 不长期缓存，资源文件可 immutable 缓存。禁止将完整 URL fragment、配对输入、RPC 正文或客户端存储导出到错误上报系统。对生产 CSP 和 Relay 连通性完成浏览器验收后再启用 Relay capability；真机蜂窝网络、网络切换和 30 分钟空闲验收仍需实际设备执行。
