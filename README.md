# Backend BRC - Guia de Deploy

Este é o servidor (backend) que faz o painel "BRC - Colheita e Comercialização"
conseguir salvar e ler dados. Ele não tem NENHUMA dependência externa —
só precisa de Node.js instalado para rodar.

Arquivos:
- `server.js` → o servidor em si
- `package.json` → identifica o projeto
- `.env.example` → modelo das variáveis de configuração (porta e chave de API)
- `data.json` → criado automaticamente, é onde os dados ficam salvos

---

## ⚠️ Importante sobre onde hospedar

Como vocês querem acesso de **fora de casa/escritório**, o servidor precisa
ficar em algum lugar sempre ligado e com IP acessível. Existem duas rotas:

### Opção A — Testar rápido e de graça (Render.com)
Bom para testar se tudo funciona. Risco: no plano gratuito, se o serviço
ficar muito tempo sem uso ele "dorme", e ao acordar pode perder os dados
gravados em `data.json` (o disco não é permanente no plano free).
**Não recomendado para guardar dados reais da fazenda a longo prazo.**

### Opção B — Uso real (recomendado)
Um servidor (VPS) pequeno e barato, sempre ligado, com disco permanente de
verdade. Custa em torno de R$20–30/mês em provedores como Hostinger,
Contabo ou DigitalOcean. Os dados nunca somem.

Comece pela Opção A pra testar rapidinho, e quando estiver satisfeito,
migre pra Opção B pra valer (o código é exatamente o mesmo nos dois casos).

---

## Opção A — Deploy rápido no Render.com (gratuito)

1. Crie uma conta em https://render.com (pode entrar com Google/GitHub).
2. Crie um repositório no GitHub e suba esta pasta (`server.js`, `package.json`).
   Se nunca usou GitHub, é só criar um repositório novo, arrastar os arquivos
   pela interface web do GitHub ("Add file > Upload files") e confirmar.
3. No Render, clique em "New +" → "Web Service" e conecte o repositório.
4. Em "Build Command" deixe em branco ou `npm install`.
5. Em "Start Command" coloque: `node server.js`
6. Em "Environment Variables", adicione:
   - `API_KEY` = (uma chave só sua — veja sugestão em `.env.example`)
7. Clique em "Create Web Service" e aguarde o deploy terminar.
8. Quando terminar, o Render te dá uma URL tipo:
   `https://brc-backend-xxxx.onrender.com`
   Essa é a URL do seu backend.

---

## Opção B — VPS (uso real, recomendado)

1. Contrate um VPS simples (Ubuntu 22.04, o menor plano já serve).
2. Acesse via SSH (o provedor te dá usuário/senha ou uma chave, e um
   passo a passo de como conectar — geralmente com um programa como
   PuTTY no Windows).
3. Instale o Node.js no servidor:
   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
4. Envie os arquivos desta pasta para o VPS (pode usar um programa como
   FileZilla/WinSCP, arrastando os arquivos por FTP/SFTP).
5. No terminal do VPS, dentro da pasta dos arquivos:
   ```
   export API_KEY="sua-chave-aqui"
   export PORT=3000
   npm install -g pm2
   pm2 start server.js --name brc-backend
   pm2 save
   pm2 startup
   ```
   (o `pm2` mantém o servidor rodando pra sempre, mesmo se o VPS reiniciar)
6. Libere a porta 3000 no firewall do VPS, ou configure um proxy
   (Nginx) com HTTPS na porta 443 — recomendo pedir ajuda de novo aqui
   quando chegar nessa etapa, que eu te guio.
7. A URL do seu backend será algo como `http://SEU-IP-DO-VPS:3000`
   (ou `https://seu-dominio.com.br` se configurar um domínio + Nginx).

---

## Depois de ter a URL (em qualquer uma das opções)

Abra o arquivo `BRC_-_Colheita_e_Comercialização.html` e troque estas
duas linhas (procure por `API_BASE` perto do início do `<script>`):

```js
const API_BASE = 'https://SEU-DOMINIO.com.br/api'; // <-- troque pela URL real da sua API
const API_KEY  = 'TROQUE-ESTA-CHAVE-NO-SERVIDOR-E-AQUI'; // <-- mesma chave configurada no servidor (.env API_KEY)
```

Por exemplo, se seu backend está em `https://brc-backend-xxxx.onrender.com`:

```js
const API_BASE = 'https://brc-backend-xxxx.onrender.com/api';
const API_KEY  = 'a-mesma-chave-que-voce-colocou-na-variavel-API_KEY-do-servidor';
```

Salve o HTML, hospede ele em qualquer lugar (até um simples GitHub Pages
ou Netlify resolve, já que ele só se conecta ao seu backend por API), e
pronto — o painel vai conseguir salvar e carregar os dados de qualquer
lugar do mundo.

---

## Testando se o backend está no ar

Depois do deploy, rode este comando (trocando a URL e a chave) para
confirmar que está tudo funcionando:

```
curl -X PUT https://SUA-URL-AQUI/api/storage/teste -H "x-api-key: SUA-CHAVE-AQUI" -H "Content-Type: application/json" -d "{\"value\":\"ok\"}"
```

Se responder algo como `{"value":"ok"}`, está funcionando perfeitamente.
