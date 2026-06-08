# 部署（macOS launchd 后台服务）

把查谱网页跑成开机自启的本机后台服务，端口 **6060**（`PORT` env 可覆盖）。同一局域网 / Tailscale 下，电脑、手机浏览器访问 `http://<本机IP>:6060` 即可。

> 非 macOS 用户：直接 `npm run build && npm start` 即可，本目录的 launchd 物料是 macOS 专用的可选项。

## 安全边界（重要）

本服务**无登录认证**——信任边界是网络本身：只在局域网 / Tailscale 内访问，**不要 port-forward 或反代到公网**。任何能访问到端口的人都能查谱、导入、写库。

- 导入接口已加 **SSRF 防护**：`/api/import/url` 拒绝抓取内网/环回/链路本地/云元数据/Tailscale CGNAT（100.64/10）地址，只允许公网 http(s)。
- 若将来要暴露到公网，必须先在前面加一层认证（反代 basic auth / Tailscale Serve 的鉴权 / 应用层 token），不要裸奔。

## 一次性安装

```bash
# 1. 拉代码（library/ 谱库不在 git 里，需另行同步，见下）
cd /path/to/tabstand   # 项目所在目录
npm ci
npm run build                # 生成 .next 产物（含 npm run scan）

# 2. 装 launchd 服务（替换占位符为本机实际路径）
#    plist 直接用 node 二进制启动（不经 shell 脚本）。若项目放在
#    ~/Documents / ~/Desktop 等 macOS TCC 保护目录下，这样可避免 launchd
#    读取脚本被 TCC 拦截（Operation not permitted）。
NODE=$(which node)
REPO=$(pwd)
mkdir -p ~/Library/LaunchAgents
sed -e "s#__NODE__#$NODE#g" -e "s#__NODE_DIR__#$(dirname "$NODE")#g" -e "s#__REPO__#$REPO#g" \
    deploy/com.tabstand.plist > ~/Library/LaunchAgents/com.tabstand.plist

# node 升级后：homebrew 路径不变 → 只需重启服务；换了 node 安装位置 → 重跑本段

# 3. 启动
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tabstand.plist
launchctl kickstart -k gui/$(id -u)/com.tabstand
```

验证：`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:6060/` 应返回 200。

## 日常运维

```bash
# 重启（改完代码 npm run build 后）
launchctl kickstart -k gui/$(id -u)/com.tabstand

# 看状态 / 日志
launchctl list | grep tabstand
tail -f deploy/tabstand.log

# 停止 / 卸载
launchctl bootout gui/$(id -u)/com.tabstand
```

> 不要用 `launchctl unload`（已废弃，会破坏服务注册）。统一用 `bootstrap` / `kickstart -k` / `bootout`。

## 谱库同步（library/ 不进 git）

`library/` 是受版权保护的扫描件，被 gitignore，需自带。迁到另一台机器的方式任选：
- `rsync -av ./library/ <user>@<host>:/path/to/tabstand/library/`
- 或直接在目标机上用网页的「导入」功能重新攒谱

同步后 `npm run scan` 刷新索引（或重启服务，build 会自动 scan）。

## 更新代码后

```bash
git pull && npm ci && npm run build
launchctl kickstart -k gui/$(id -u)/com.tabstand
```
