FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json eslint.config.js ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.app.json apps/web/vite.config.ts apps/web/index.html ./apps/web/
COPY apps/academic-worker/package.json apps/academic-worker/tsconfig.json ./apps/academic-worker/
RUN npm ci
COPY packages/shared/src ./packages/shared/src
COPY apps/server/src ./apps/server/src
COPY apps/web/public ./apps/web/public
COPY apps/web/src ./apps/web/src
COPY apps/academic-worker/src ./apps/academic-worker/src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production AFTERDRAFT_DATA_DIR=/data AFTERDRAFT_WEB_DIR=/app/apps/web/dist AFTERDRAFT_PORT=4310
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:4310/health || exit 1
CMD ["node","apps/server/dist/index.js"]
