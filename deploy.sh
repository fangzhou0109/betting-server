#!/bin/bash
# GCP e2-micro 一键部署脚本
# 在 VM 上以 root 或 sudo 运行

set -e

echo "=== 1. 安装 Docker ==="
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "=== 2. 克隆项目 ==="
cd /opt
if [ ! -d "betting-server" ]; then
  git clone https://github.com/fangzhou0109/betting-server.git
fi
cd betting-server

echo "=== 3. 配置环境变量 ==="
if [ ! -f .env ]; then
  cp .env.production .env
  echo ">>> 请编辑 /opt/betting-server/.env 填入真实密码和域名"
  echo ">>> 然后重新运行此脚本或执行: docker compose -f docker-compose.prod.yml up -d"
  exit 0
fi

echo "=== 4. 开放防火墙 ==="
# GCP 防火墙需在控制台开放 80/443，这里开放本机 iptables
iptables -A INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
iptables -A INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true

echo "=== 5. 启动服务 ==="
export $(grep -v '^#' .env | xargs)
docker compose -f docker-compose.prod.yml up -d --build

echo ""
echo "=== 部署完成 ==="
echo "API 地址: https://${API_DOMAIN}"
echo ""
echo "查看日志: docker compose -f docker-compose.prod.yml logs -f"
echo "重启服务: docker compose -f docker-compose.prod.yml restart"
