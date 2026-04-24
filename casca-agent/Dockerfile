FROM node:20-slim

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY agent.js .
COPY .env.example .

RUN mkdir -p .cache .updates

CMD ["node", "agent.js"]
