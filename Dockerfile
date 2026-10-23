FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
ENV NODE_ENV=production 
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["node", "dist/index.js"]
