#!/bin/bash
# OverSCCed 一键开服（Mac 版）— 网址自动发布，入口固定
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE="node"
elif [ -x "/Users/xueyuguowang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
  NODE="/Users/xueyuguowang/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
else
  echo "需要安装 Node.js（免费）：https://nodejs.org 安装后重新双击本文件。"
  read -p "按回车关闭…"
  exit 1
fi

echo "OverSCCed 开服中… 这个窗口不要关"
echo "玩家入口（永久不变）: https://你的用户名.github.io/overscced/go.html"

# 游戏服务器（挂了自动重启）
(while true; do
  "$NODE" server/server.js 3000 >> "$HOME/overscced_server.log" 2>&1
  sleep 2
done) &

# 隧道（挂了自动重启）+ 网址自动发布
(while true; do
  ssh -i "$(dirname "$0")/服务器钥匙" -o StrictHostKeyChecking=no \
      -o ServerAliveInterval=15 -R 80:localhost:3000 plan@localhost.run 2>&1 | tee -a "$HOME/overscced_tunnel.log"
  sleep 3
done) &

# 监视器：隧道每次拿到新网址，就自动发布到固定入口
(LAST=""
 while true; do
   D=$(grep -oE "[a-z0-9]+\.lhr\.life" "$HOME/overscced_tunnel.log" 2>/dev/null | tail -1)
   if [ -n "$D" ] && [ "$D" != "$LAST" ]; then
     LAST="$D"
     "$NODE" "$(dirname "$0")/server/publish_url.js" "https://$D" >> "$HOME/overscced_pub.log" 2>&1
     echo "已发布最新网址: https://$D"
   fi
   sleep 5
 done) &

wait
