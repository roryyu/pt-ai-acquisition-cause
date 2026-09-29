#!/usr/bin/env bash
# pt-ai-acquisition-cause 发布打包脚本（在本地 Mac 运行）
#
# 背景：服务器到 GitHub 拉取缓慢，代码分发改走「本脚本打包 → JumpServer 文件上传 → 服务器解压」
#       （对应 deploy.md 步骤 1C 首次分发与 §4.1 常规发版）
#
# 产物：dist/cause-release-<版本>.tar.gz（版本 = git 短 SHA；仓库未 git 化时用时间戳）
#   收纳：docker build 全部所需（源码、package-lock、prisma schema+基线迁移、Dockerfile、compose）
#         + 运维脚本 + 根级文档 + RELEASE-INFO 版本标识
#   排除：.git、node_modules、.next、lib/db/generated、.env 密钥、doc/backups/tests、data 本地内容、
#         Agent 工作区（.qoder/.claude/.windsurf/.agents）等非运行资料
#   补齐：三个运行时目录骨架（data/research-graph、public/exports、.deliveries，均为空目录）
#
# 用法：bash scripts/pack-release.sh [输出目录]    # 输出目录默认 ./dist

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

# ---------- 1. 前置校验：部署关键文件必须齐备 ----------
REQUIRED=(
  Dockerfile
  .dockerignore
  docker-compose.yml
  package.json
  package-lock.json
  .npmrc
  prisma.config.ts
  next.config.ts
  tsconfig.json
  postcss.config.mjs
  prisma/schema.prisma
  prisma/migrations/0_init/migration.sql
  app/api/health/route.ts
)
MISSING=0
for f in "${REQUIRED[@]}"; do
  if [ ! -f "$f" ]; then
    echo "!! 缺少 $f"
    MISSING=1
  fi
done
if [ "$MISSING" -ne 0 ]; then
  echo ">> 基线迁移缺失时，先执行 deploy.md 步骤 0.1–0.2 生成 prisma/migrations/0_init，再重跑本脚本"
  exit 1
fi

# ---------- 2. 版本标识与输出路径 ----------
if git rev-parse --short HEAD >/dev/null 2>&1; then
  VERSION=$(git rev-parse --short HEAD)
else
  VERSION=$(date +%Y%m%d%H%M)
fi
OUT_DIR=${1:-dist}
ARCHIVE="$REPO_ROOT/$OUT_DIR/cause-release-$VERSION.tar.gz"

# ---------- 3. 组装 staging（显式清单逐项拷贝，不依赖 exclude 通配语义，跨 bsdtar/GNU tar 行为一致） ----------
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/cause-pack.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/root"

TOP_ITEMS=(
  Dockerfile
  .dockerignore
  docker-compose.yml
  .gitignore
  .env.example
  package.json
  package-lock.json
  .npmrc
  prisma.config.ts
  next.config.ts
  tsconfig.json
  postcss.config.mjs
  eslint.config.mjs
  skills-lock.json
  prisma
  app
  components
  hooks
  lib
  scripts
  public
  README.md
  AGENTS.md
  CLAUDE.md
  prepare.md
  install.md
  deploy.md
)
for item in "${TOP_ITEMS[@]}"; do
  if [ ! -e "$item" ]; then
    echo "!! 打包清单项不存在：$item（清单与仓库现状不一致，请先修正脚本清单）"
    exit 1
  fi
  cp -R "$item" "$STAGE/root/"
done

# 剔除本地开发产物（体积大/平台相关；docker build 内会重新生成）
rm -rf "$STAGE/root/lib/db/generated" \
       "$STAGE/root/public/exports" \
       "$STAGE/root/scripts/__pycache__"

# 运行时落盘目录补空骨架（服务器实际路径由 docker-compose.override.yml 重定向到 /srv/cause）
mkdir -p "$STAGE/root/data/research-graph" \
         "$STAGE/root/public/exports" \
         "$STAGE/root/.deliveries"

# 版本标识：服务器端 cat RELEASE-INFO 即知当前部署的是哪个包
printf 'version=%s\npacked_at=%s\n' "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$STAGE/root/RELEASE-INFO"

# 安全断言：密钥绝不入包（显式清单本不含 .env，此处双保险）
if [ -e "$STAGE/root/.env" ]; then
  echo "!! 安全检查失败：.env 混入包内，终止"
  exit 1
fi

# ---------- 4. 打包（COPYFILE_DISABLE 阻止 macOS bsdtar 写入 ._ AppleDouble 条目污染 Linux 解压） ----------
mkdir -p "$REPO_ROOT/$OUT_DIR"
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$STAGE/root" .

# ---------- 5. 产物报告与后续操作指引 ----------
SIZE=$(du -h "$ARCHIVE" | cut -f1)
SHA=$(shasum -a 256 "$ARCHIVE" | cut -d' ' -f1)
FILES=$(tar -tzf "$ARCHIVE" | wc -l | tr -d ' ')

echo "打包完成"
echo "  产物   : $ARCHIVE"
echo "  大小   : $SIZE（$FILES 个条目）"
echo "  sha256 : $SHA"
echo
echo "—— 后续操作（deploy.md 步骤 1C）——"
echo "  1. JumpServer 文件管理：上传上面这个压缩包到服务器 /home/ec2-user/"
echo "  2. 服务器校验完整性（应与上面 sha256 一致）："
echo "       sha256sum ~/cause-release-$VERSION.tar.gz"
echo "  3. 服务器解压："
echo "       mkdir -p /srv/cause/app"
echo "       tar -xzf ~/cause-release-$VERSION.tar.gz -C /srv/cause/app"
