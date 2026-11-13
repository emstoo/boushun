FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl iproute2 iputils-ping libcap2-bin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node LICENSE README.md ./
RUN mkdir -p /data \
    && chown -R node:node /data \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
    && getcap -r / 2>/dev/null \
      | while IFS= read -r capability; do setcap -r "${capability% *}"; done \
    && setcap cap_net_raw=ep /usr/bin/ping \
    && test -z "$(find / -xdev -type f -perm /6000 -print -quit)" \
    && test "$(getcap -r / 2>/dev/null)" = "/usr/bin/ping cap_net_raw=ep"
USER node
ENV BOUSHUN_HOST=127.0.0.1 BOUSHUN_PORT=4177 BOUSHUN_DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.BOUSHUN_PORT || '4177') + '/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]
CMD ["node", "src/server.js"]
