# dsh-settings-lan-patch

放开 DSH Web 设置面板的「仅限本机回环」限制，让 `--trusted-host` / `trustedHosts`
白名单里的局域网来源（如 `http://172.12.0.1:3080`、`dsh.pi`）也能正常读写设置，
修复「加载提供商目录失败: settings are unavailable in this browser」。

## 背景（为什么会有这个问题）
DSH 出于安全把设置文档读取写成 `ctx.remote.$host.isLoopback ? "host" : "memory"`：
- **回环**（localhost/127.x）→ 设置镜像会去读宿主设置文档；
- **非回环**（局域网 IP / 域名，即使已在 trusted-host 白名单）→ 设置镜像进入 `memory`
  模式，永远读不到设置 → 模型/提供商标录加载失败，设置文档编辑器整页隐藏。

本补丁把这两处回环判断去掉，但**不裸奔开放**：API 层的
`--trusted-host` / `trustedHosts` 白名单仍然约束谁能访问。

## 改动点（核心 node_modules，升级后会被还原、需重打）
| 文件 | 位置 | 改动 |
|---|---|---|
| `dsh-client-ui-settings/lib/client.js` | `SettingsDescribeMirror` 持久化 | `isLoopback ? "host" : "memory"` → 恒 `"host"` |
| `dsh-client-ui-settings-general/lib/client.js` | 设置文档编辑器创建 | 有回环判断 → 恒创建 |

全局核心路径：`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

## 用法
```bash
# 打补丁（幂等，重复跑会跳过已打的；升级后可重打）
sudo python3 scripts/patch-settings-lan.py

# 只看状态
sudo python3 scripts/patch-settings-lan.py --status

# 只备份
sudo python3 scripts/patch-settings-lan.py --backup
```

打完后**刷新浏览器页面**即可生效。不需要重启 `dsh.service`：
Web 组合的 `client-hmr` 每 500ms 轮询客户端 bundle 文件，发现改动自动 re-build 并广播。

## 升级核心后的操作
升级会覆盖核心 node_modules → 两处改动被还原。升级后执行：
```bash
sudo python3 /home/wdf-pai/dsh-settings-lan-patch/patch-settings-lan.py
```
脚本会识别「clean（原版）」状态并重新打补丁；若显示 `other`，说明文件被其他方式改动过，需人工确认。

## 备份
每次打补丁前自动备份到 `backups/` 目录（时间戳命名），原文件随时可还原。
