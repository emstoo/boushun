FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iproute2 iputils-ping \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node LICENSE README.md ./
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV BOUSHUN_HOST=127.0.0.1 BOUSHUN_PORT=4177 BOUSHUN_DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BOUSHUN_PORT || '4177') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "src/server.js"]
