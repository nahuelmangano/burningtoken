FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html styles.css server.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
