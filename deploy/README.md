# 部署（Docker）

```bash
npm install
npm run build
docker compose -f deploy/docker-compose.yml up -d --build
```

容器内 nginx 用 `deploy/default.conf.template`（环境变量替换）：
`/` 与 `/assets/` 走前端静态文件，`/panel-snapshot`、`/ws`、`/api/`、
`/static/` 透传给面板，`/login`、`/admin`、`/dashboard` 跳到面板主域名
（OAuth 回调只认那一个域名，透传会对不上），`/unlock/`、`/cal/`、
`/services/` 分别透传给配套小服务。模板里的 `<your-panel-domain>`
换成你自己的面板主域名；配套小服务没有就把对应 location 删掉。
