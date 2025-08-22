FROM node:18-alpine
WORKDIR /app
COPY package.json package.json
RUN npm install --production
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/bot.js"]
