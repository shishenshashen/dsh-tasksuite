#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-settings-lan-patch
======================
用途：让 DSH Web 的设置面板/模型面板不再“仅限本机回环”，
      并对已在 --trusted-host / trustedHosts 白名单里的局域网来源开放读写。

背景：DSH 把设置文档的读取写成 `ctx.remote.$host.isLoopback ? "host" : "memory"`，
      非回环浏览器（如 http://172.12.0.1:3080 或 dsh.pi）即便在 trusted-host 白名单，
      设置镜像也永远读不到宿主设置文档 → “加载提供商目录失败: settings are unavailable
      in this browser”，且设置文档编辑器整页隐藏。

本脚本幂等：已打过补丁则跳过；升级核心后文件被还原时，重跑即可重新打。
用法：
    sudo python3 patch-settings-lan.py            # 打补丁
    sudo python3 patch-settings-lan.py --status    # 只看当前状态，不改文件
    sudo python3 patch-settings-lan.py --backup    # 只备份，不改文件
"""

import os
import shutil
import sys
import datetime

# 目标文件：DSH 全局核心 node_modules 下的两个客户端文件
SETTINGS = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js"
GENERAL  = "/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js"

TAG = "[pai-lan-patch]"
BACKUP_ROOT = "/home/wdf-pai/dsh-settings-lan-patch/backups"

# 每处的 (文件, 原始串, 补丁串)
PATCHES = [
    (
        SETTINGS,
        'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";',
        'const persistence = "host"; // ' + TAG + ': serve host settings doc to trusted LAN clients, not only loopback',
    ),
    (
        GENERAL,
        'const documentController = ctx.remote.$host.isLoopback ? new SettingsDocumentStore(ctx, ctx.configForms.describe()) : void 0;',
        'const documentController = new SettingsDocumentStore(ctx, ctx.configForms.describe()); // ' + TAG + ': enable native settings editor for trusted LAN clients',
    ),
]


def state_of(path, patched, original):
    """返回 'patched' | 'clean' | 'other'。"""
    if not os.path.exists(path):
        return "missing"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    if patched in content:
        return "patched"
    if original in content:
        return "clean"
    return "other"


def backup(path):
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    name = os.path.basename(os.path.dirname(os.path.dirname(path))) or "unknown"
    dst = os.path.join(BACKUP_ROOT, f"{ts}__{name}.client.js")
    shutil.copy2(path, dst)
    return dst


def main():
    only_status = "--status" in sys.argv
    only_backup = "--backup" in sys.argv

    changed = 0
    for path, original, patched in PATCHES:
        name = os.path.basename(os.path.dirname(os.path.dirname(path)))
        state = state_of(path, patched, original)
        if state == "missing":
            print(f"[SKIP] {name}: 文件不存在 —— {path}")
            continue
        if only_backup:
            dst = backup(path)
            print(f"[BACKUP] {name}: -> {dst}")
            continue
        if state == "patched":
            print(f"[OK]   {name}: 已打过补丁，跳过")
            continue
        if state == "clean":
            if only_status:
                print(f"[CLEAN] {name}: 尚未打补丁（升级后被还原，可重打）")
                continue
            backup(path)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            content = content.replace(original, patched, 1)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"[PATCH] {name}: 已备份并打补丁")
            changed += 1
        else:
            print(f"[WARN] {name}: 内容既不是原版也不是本补丁（可能被其他补丁改动），未动 —— {path}")

    if only_status:
        print("\n状态: 用 `sudo python3 patch-settings-lan.py` 可对 clean/missing 项重打。")
    elif only_backup:
        print(f"\n备份目录: {BACKUP_ROOT}")
    elif changed == 0:
        print("\n无需改动（均已打补丁）。")
    else:
        print(f"\n已打补丁 {changed} 处。刷新浏览器即可生效（client-hmr 监听客户端 bundle，无需重启）。")


if __name__ == "__main__":
    main()
