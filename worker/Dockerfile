FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY worker/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && useradd -u 10001 -m app
COPY worker/tsconfig.json ./
COPY worker/src ./src
USER app
ENV HOME=/runs PI_OFFLINE=1
CMD ["node", "--import", "tsx", "src/index.ts"]
