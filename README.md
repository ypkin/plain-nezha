# Plain

基于 [tom2almighty/monitor-theme-design](https://github.com/tom2almighty/monitor-theme-design) 定制的 nezha-zero 公开页前端：整页扁平化，节点一览 + 解锁与已部署业务实查。

## 截图

首页：顶部统计栏 + 节点表（深色模式）

![首页](screenshots/home.png)

节点详情 → 已部署业务：实查徽标 + 上次时间 + 重新检测

![已部署业务](screenshots/services.png)

节点详情 → 解锁：8 项服务分 IPv4 / IPv6 两行，IP 由前端脱敏

![解锁](screenshots/unlock.png)

## 功能

- **整页扁平化**：去掉全部装饰阴影、渐变、毛玻璃与顶部高光，改实色；选中分组 pill 保持蓝色实色 `#0A6CFF`。保留壁纸、彩虹 logo、统计栏多彩字、焦点圈、圆点纹理与 🔥⚡ 脉动、圆角。
- **点阵世界地图背景**：真实世界地图数据生成的点阵图（`public/dot-map.svg`）作页面背景，同一张图以 mask 方式在深浅模式下通用，边缘带淡化。
- **顶部统计栏**：在线数、实时 + 累计流量、最忙（🔥）、最快（⚡），按当前分组统计。
- **节点列表**：状态列徽标逻辑（最忙 🔥、最快 ⚡）与行名同步变色；末列为到期；展开行同时只开一个节点。
- **详情 4 个标签页**：网络延迟、系统概览、解锁、已部署业务。
  - 网络延迟：延迟图档位 1 小时 / 6 小时 / 24 小时。
  - 解锁：Netflix、Disney+、HBO Max、YouTube、ChatGPT、Claude、Gemini、Muse，IPv4 一行、IPv6 一行；IP 前端脱敏（v4 只显前两段，v6 只显前缀）。
  - 已部署业务：到节点实查服务在不在跑，徽标 ✓ 在跑 / ✗ 停了 / ? 未知，附上次检测时间；点「重新检测」排队重查，查完自动刷新。
- **流量校准**：配套的服务端（见下方 `CAL`）存取每月流量校准，校准密码只存 PBKDF2 哈希。
- **亮色 / 暗色**，移动端单元格紧凑（上下内边距 6px）。

## 部署方式

### 准备工作

- 一台在跑的 nezha-zero 面板（dashboard）。本项目只是公开页前端，**不含面板本身**。
- 一台能跑 Docker 的主机；本地构建需要 Node.js（建议 20+）。

### 步骤

```bash
git clone https://github.com/ypkin/plain-nezha.git
cd plain-nezha

# 1. 本地构建（产物 dist/，不进 git）
npm install
npm run build

# 2. 改 deploy/docker-compose.yml 里的环境变量（见下表）
# 3. 把 deploy/default.conf.template 里的 <your-panel-domain> 换成你自己的面板主域名
#    （配套小服务没有的，把模板里对应 location 删掉）

# 4. 构建并启动
docker compose -f deploy/docker-compose.yml up -d --build
```

容器监听 `127.0.0.1:8086`，自己再反代域名并上证书，例如：

```nginx
server {
    listen 443 ssl;
    server_name <your-frontend-domain>;

    location / {
        proxy_pass http://127.0.0.1:8086;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
    }
}
```

注意 `/ws` 的 `Host` 必须带端口（`$http_host`）：nezha-zero 的 `/ws` 握手做 Origin 检查，剥掉端口会 403、表现为全节点离线。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `NEZHA` | 面板地址，**必须以 `/` 结尾**，如 `http://127.0.0.1:8008/` |
| `NEZHA_ORIGIN` | 面板主域名（不带尾斜杠），`/login`、`/admin`、`/dashboard` 跳向这里 |
| `CAL` | 流量校准服务地址，可选；没有就留空并删模板里 `/cal/` 段 |
| `UNLOCK` | 解锁聚合服务地址，可选；没有就留空并删模板里 `/unlock/` 段 |
| `SERVICES` | 已部署业务汇总服务地址，可选；没有就留空并删模板里 `/services/` 段 |

### 路由说明

容器内 nginx（`deploy/default.conf.template`，环境变量替换）：

- `/` 与 `/assets/`：前端静态文件。
- `/panel-snapshot`、`/ws`、`/api/`、`/static/`：透传给面板。
- `/login`、`/admin`、`/dashboard`：302 跳到面板主域名。OAuth 回调只登记主域名，透传跨域对不上，所以这里必须跳。
- `/unlock/`、`/cal/`、`/services/`：分别透传给配套小服务。

配套小服务（流量校准、解锁聚合、业务汇总）不在本仓库内，需要另外部署；没有就不配，前端对应标签页/按钮不出现。

## 本地开发

```bash
npm install
npm run dev      # 开发服务器
npm run build    # tsc -b && vite build，产物在 dist/
npm run preview  # 本地预览构建产物
```

## 协议与致谢

- 本项目基于 [MIT License](LICENSE) 开源。
- 原作者 [tom2almighty](https://github.com/tom2almighty) 的 [monitor-theme-design](https://github.com/tom2almighty/monitor-theme-design)，页脚署名保留。
- 感谢 [monitor-probe/monitor](https://github.com/monitor-probe/monitor)。
- 国旗图标来自 [flag-icons](https://github.com/lipis/flag-icons)，MIT 协议。
