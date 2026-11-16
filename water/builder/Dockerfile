# The water builder (server.mjs) and the water map's own code, laid out unchanged by prepare.mjs.
FROM node:22-slim
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY app/ ./
ENV PORT=8080
# the standard-1 instance has 4 GiB: the main thread may use up to 2.5 GiB (the shade thread has its own limit, headless.mjs)
ENV NODE_OPTIONS=--max-old-space-size=2560
EXPOSE 8080
CMD ["node", "builder/server.mjs"]
