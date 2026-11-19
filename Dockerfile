# ScanDrop production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# su-exec lets the container start as root (to fix volume permissions) and then
# run the app as the unprivileged "node" user.
RUN apk add --no-cache su-exec

# Install only runtime dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code
COPY server.js ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip any Windows line endings, then make it runnable
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Uploaded files and metadata live on a mounted volume at /data
ENV STORAGE_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
