FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.app.json ./apps/web/
COPY apps/academic-worker/package.json apps/academic-worker/tsconfig.json ./apps/academic-worker/
RUN npm ci
COPY apps/academic-worker/src ./apps/academic-worker/src
RUN npm run build -w @profread/academic-worker
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    ACADEMIC_WORKER_PORT=4312 \
    ACADEMIC_WORKER_CONCURRENCY=2 \
    ACADEMIC_WORKER_MAX_BODY_BYTES=104857600 \
    ACADEMIC_WORKER_MAX_OUTPUT_BYTES=230686720 \
    CHROMIUM_PATH=/usr/bin/chromium \
    PROFREAD_WORKER_HOME=/tmp/profread-worker-home \
    XDG_CACHE_HOME=/tmp/profread-worker-cache \
    XDG_CONFIG_HOME=/tmp/profread-worker-config \
    SAL_USE_VCLPLUGIN=svp
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-dejavu-core fonts-liberation2 fonts-noto-cjk fonts-noto-core \
      latexml libreoffice-math libreoffice-writer pandoc poppler-utils zip \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-kor \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/academic-worker/package.json ./apps/academic-worker/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/academic-worker/dist ./apps/academic-worker/dist
USER node
EXPOSE 4312
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4312/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/academic-worker/dist/index.js"]
