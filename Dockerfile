FROM node:20-slim

ENV NODE_ENV=production \
    PORT=8000 \
    EO_PYTHON=python3

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-minimal ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY app/static ./app/static
COPY eo_bridge ./eo_bridge

RUN mkdir -p data/charts && chown -R node:node /app
USER node

EXPOSE 8000
CMD ["node", "server.js"]
