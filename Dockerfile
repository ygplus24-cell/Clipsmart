FROM node:22-slim

# Install FFmpeg, FFprobe, and DejaVu fonts required by libass subtitle burn-in
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build frontend dist/ for single-service Cloud Run or static health verification
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.ts"]
