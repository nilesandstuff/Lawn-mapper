# The water builder (server.mjs) and the water map's own code, laid out unchanged by prepare.mjs.
FROM node:22-slim
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app/ ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "builder/server.mjs"]
