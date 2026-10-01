# Keep this version equal to apps/worker's playwright-core dependency.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --omit=dev

ENV NODE_ENV=production
USER pwuser
EXPOSE 10000
CMD ["node", "apps/worker/src/server.js"]
