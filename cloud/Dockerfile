FROM node:22-alpine
WORKDIR /srv
COPY package.json server.js ./
RUN mkdir -p /srv/data && chown node:node /srv/data
ENV NODE_ENV=production DATA_FILE=/srv/data/summaries.jsonl
USER node
EXPOSE 8080
CMD ["node", "server.js"]
