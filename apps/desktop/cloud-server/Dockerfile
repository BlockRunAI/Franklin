FROM node:22-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

ENV FRANKLIN_CLOUD_HOST=0.0.0.0 \
    FRANKLIN_CLOUD_PORT=3740 \
    FRANKLIN_CLOUD_DATA_DIR=/data \
    FRANKLIN_CLOUD_SANDBOX_PROVIDER=directory

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3740
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3740/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
