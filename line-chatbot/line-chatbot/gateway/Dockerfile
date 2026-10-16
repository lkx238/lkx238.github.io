FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server.mjs ./server.mjs
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
