FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public

ENV CHROME_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    NO_SANDBOX=1 \
    PORT=3300
VOLUME /data
EXPOSE 3300

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
