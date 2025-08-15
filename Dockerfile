FROM node:18-alpine

# Instalar dependências do sistema
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    linux-headers

# Criar diretório de trabalho
WORKDIR /app

# Copiar arquivos do projeto
COPY package*.json ./
RUN npm install

# Copiar código da aplicação
COPY server.js ./
COPY public/ ./public/

# Expor porta
EXPOSE 3000

# Comando para iniciar
CMD ["node", "server.js"]