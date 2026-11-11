# The shade build's Node server (server.mjs) and the shade map's own modules, copied in unchanged by prepare.mjs.
FROM node:22-slim
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app/ ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
