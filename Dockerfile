FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# server.js 只用 Node 内置模块，没有运行时 npm 依赖
COPY server.js index.html app.js config.js ./
COPY audio ./audio

EXPOSE 10000
CMD ["node", "server.js"]
