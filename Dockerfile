# Question register: single container, SQLite on a mounted volume.
FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/register.sqlite
# No runtime dependencies: just copy the sources.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY seed ./seed
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
