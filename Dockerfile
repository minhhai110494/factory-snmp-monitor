FROM node:20-alpine

WORKDIR /app

# Khong co thu vien ngoai (Zero NPM dependencies)
COPY package.json ./
COPY server.js ./
COPY config ./config
COPY public ./public

EXPOSE 3000

# Luu y: Chay voi --net=host de quet card mang va SNMP truc tiep tren LAN
CMD ["node", "server.js"]
