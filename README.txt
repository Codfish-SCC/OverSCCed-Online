OverSCCed — 校园桌游网页版
========================

【联机版 · 零服务器方案】
双击 index.html（或托管到 GitHub Pages 生成永久网址）即可联机：
房主的浏览器就是服务器，公共消息服务器（EMQX 中国节点）中转。
开房：Create room → 拿到 4 位房号；加入：输入房号 Join。
6 玩家 + 4 观众，Mac/Windows/手机通用，无需任何账号和费用。

部署永久网址：看 DEPLOY.txt（GitHub Pages，3 分钟）。

【单机热座版】双击 solo.html（一台设备轮流玩）。

开发文件：rules.js（规则引擎）、config.js（57 格棋盘标定）、
mqtt_host.js（房主模式房间逻辑）、mqtt.min.js（消息库）、
server/（局域网 Node 服务器版 + 自动化测试）。
