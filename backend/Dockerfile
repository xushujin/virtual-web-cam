# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      g++ \
      make \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production \
    PORT=8177 \
    SQLITE_PATH=/data/virtualwebcam.db \
    DOCKER_SOCKET=/var/run/docker.sock \
    DOCKER_NETWORK=onvif_macvlan \
    VIRTUALWEBCAM_IMAGE=virtualwebcam:latest \
    API_TOKEN= \
    CORS_ORIGIN=

VOLUME ["/data"]
EXPOSE 8177

CMD ["node", "src/server.js"]
