FROM node:20-slim

ENV NODE_ENV=production \
    PORT=8000

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY app/static ./app/static

RUN mkdir -p data/charts && chown -R node:node /app
USER node

EXPOSE 8000
CMD ["node", "server.js"]
