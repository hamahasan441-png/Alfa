FROM node:22-bookworm-slim
COPY sse-server.mjs /srv/sse-server.mjs
CMD ["node", "/srv/sse-server.mjs"]
