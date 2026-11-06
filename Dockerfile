FROM node:22-alpine

WORKDIR /app

# Só dependências em JavaScript puro: não precisa mais de python, make e g++
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY public/ ./public/

EXPOSE 3000
CMD ["node", "server.js"]
