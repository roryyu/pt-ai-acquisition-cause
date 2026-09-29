# syntax=docker/dockerfile:1
# pt-ai-acquisition-cause 应用镜像
# 基座 node:24-bookworm-slim 与 package.json engines 24.7.0 对齐（.npmrc engine-strict）；
# 目标机 m7g.xlarge 为 arm64，在服务器上原生构建，无需交叉模拟
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# 依赖层单独缓存：postinstall 会执行 prisma generate，
# 因此 prisma.config.ts 与 prisma/schema.prisma 需先于 npm ci 就位
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# 源码与构建。next build 在构建期会导入服务端模块（lib/env.ts 的 zod 校验 fail-fast），
# 故为构建层提供可通过校验的占位值；这些值仅存在于该 RUN 层，运行时由容器环境变量覆盖
COPY . .
RUN APP_ENV=production \
    APP_URL=http://127.0.0.1:3100 \
    AUTH_SECRET=build-time-placeholder-secret-0123456789abcdef \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=cause \
    MODEL_GATEWAY_BASE_URL=http://127.0.0.1:1 \
    MODEL_GATEWAY_API_KEY=build-placeholder \
    MODEL_GATEWAY_DEFAULT_MODEL=build-placeholder \
    REDIS_URL=redis://127.0.0.1:6379 \
    npm run build

# 运行时可写目录：服务器上被 bind mount 覆盖为宿主目录；
# 本地全容器运行时直接写镜像层，故预授权给 node 用户（UID 1000，与宿主 /srv/cause 属主一致）
RUN mkdir -p data/research-graph public/exports .deliveries \
    && chown -R node:node /app/.next /app/data /app/public /app/.deliveries

USER node
EXPOSE 3100

# npm start = next start -p 3100（监听 0.0.0.0，供 ALB 经实例私网 IP 访问）
CMD ["npm", "run", "start"]
