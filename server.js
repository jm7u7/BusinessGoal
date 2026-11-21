// Servidor local (npm start). En Vercel no se usa: la API la sirve api/[...slug].js y public/ es estático.
const http = require('http');
const fs = require('fs');
const path = require('path');
require('./env');
const { api, json } = require('./app');

const PORT = process.env.PORT || 3100;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); json(res, 500, { error: 'Error interno' }); }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`BusinessGoal en http://localhost:${PORT} (y en la red: http://<IP-de-este-equipo>:${PORT})`);
  // modo local: este mismo programa trae los datos de Kairos cada INTERVALO_SEG (AGENTE=0 para desactivarlo)
  if (process.env.AGENTE !== '0') require('./agente/push').iniciar();
});
