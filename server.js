const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PAQUETE_SEDE, laserMes, paquetesDetalle, SEDES, verificar, listarUsuarios, crearUsuario, eliminarUsuario, ventasDiarias, metaMes, diasDelMes } = require('./data');

const PORT = process.env.PORT || 3100;
const PUB = path.join(__dirname, 'public');
const sesiones = new Map(); // token -> usuario

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(obj));
};
const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
const usuarioDe = (req) => sesiones.get(cookie(req).sid);
const esAdmin = (u) => !u.sedes;
const sedesPermitidas = (u) => (u.sedes ? u.sedes : SEDES.map((s) => s.id));
const hoyLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function leerBody(req) {
  return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
}

// incluirHoy=false: no cuentan las ventas de hoy (el corte pasa a ayer). Los domingos siempre cuentan.
async function resumen(anio, mes, sedes, incluirHoy) {
  const hoy = incluirHoy ? hoyLocal() : (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const dias = await ventasDiarias(anio, mes, sedes, hoy);
  const libre = () => false; // ningún día se excluye de la meta
  const n = dias.filter((d) => !libre(d.fecha)).length; // días que cuentan para la meta
  const meta = await metaMes(anio, mes, sedes);
  const metaDiaria = n ? meta / n : 0;
  let acum = 0, cont = 0, diasTrans = 0;
  const serie = dias.map((d) => {
    const esLibre = libre(d.fecha), pasado = d.fecha <= hoy;
    if (!esLibre) { cont++; if (pasado) { acum += d.venta || 0; diasTrans++; } }
    return {
      dia: d.dia, fecha: d.fecha, libre: esLibre,
      venta: esLibre || !pasado ? null : d.venta,
      acumulada: pasado ? acum : null,
      metaAcum: metaDiaria * cont, meta: esLibre ? 0 : metaDiaria,
    };
  });
  const real = acum, esperado = metaDiaria * diasTrans, restantes = n - diasTrans;

  // paquetes de láser (12 sesiones) por sede; con domingos apagado no se cuentan los de domingo
  const lm = await laserMes(anio, mes);
  const porSede = SEDES.filter((s) => sedes.includes(s.id) && PAQUETE_SEDE[s.id]).map((s) => {
    const cfg = PAQUETE_SEDE[s.id];
    let sesiones = 0;
    for (const [fecha, porCod] of Object.entries(lm)) {
      if (fecha > hoy || libre(fecha)) continue;
      for (const c of s.codigos) sesiones += (porCod[c] && porCod[c][cfg.tipo]) || 0;
    }
    return { id: s.id, nombre: s.nombre, sesiones, meta: cfg.meta, tipo: cfg.tipo };
  });
  // detalle: solo lo que realmente se contabilizó (mismo producto que cuenta la sede, no anulado, no futuro, sin domingos si se apagó)
  const detalle = [];
  for (const x of await paquetesDetalle(anio, mes)) {
    const s = SEDES.find((q) => q.codigos.includes(x.cod));
    const cfg = s && PAQUETE_SEDE[s.id];
    if (!cfg || !sedes.includes(s.id) || x.tipo !== cfg.tipo || x.fecha > hoy || libre(x.fecha)) continue;
    detalle.push({ fecha: x.fecha, sede: s.nombre, tipo: x.tipo, producto: x.producto, cant: x.cant, monto: x.monto, doc: x.doc });
  }
  const laser = porSede.length ? { total: porSede.reduce((t, x) => t + x.sesiones, 0), meta: porSede.reduce((t, x) => t + x.meta, 0), porSede, detalle } : null;

  return {
    laser,
    kpi: {
      meta, esperado, real, faltante: Math.max(meta - real, 0),
      pctEsperado: esperado ? real / esperado : null,
      metaDiaria, promedio: diasTrans ? real / diasTrans : null,
      deficitDiario: restantes > 0 ? Math.max(meta - real, 0) / restantes : 0,
    },
    serie,
  };
}

async function api(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const { usuario, clave } = await leerBody(req);
    const u = verificar(usuario, clave);
    if (!u) return json(res, 401, { error: 'Usuario o clave incorrectos' });
    const sid = crypto.randomBytes(24).toString('hex');
    sesiones.set(sid, { usuario: u.usuario, nombre: u.nombre, sedes: u.sedes });
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }
  if (url.pathname === '/api/logout') {
    sesiones.delete(cookie(req).sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }
  const u = usuarioDe(req);
  if (!u) return json(res, 401, { error: 'No autenticado' });

  if (url.pathname === '/api/me') {
    const ids = sedesPermitidas(u);
    return json(res, 200, { nombre: u.nombre, usuario: u.usuario, admin: esAdmin(u), sedes: SEDES.filter((s) => ids.includes(s.id)).map(({ id, nombre }) => ({ id, nombre })), hoy: hoyLocal() });
  }
  if (url.pathname === '/api/ventas') {
    const q = url.searchParams;
    const anio = 2026; // el panel trabaja solo con 2026
    const mes = Math.min(12, Math.max(1, +q.get('mes') || new Date().getMonth() + 1));
    const permitidas = sedesPermitidas(u);
    // El servidor impone el filtro: nunca confía en lo que pida el navegador.
    let pedidas = (q.get('sedes') || '').split(',').filter(Boolean);
    pedidas = pedidas.length ? pedidas.filter((s) => permitidas.includes(s)) : permitidas;
    if (!pedidas.length) pedidas = permitidas;
    return json(res, 200, { sedes: pedidas, ...(await resumen(anio, mes, pedidas, q.get('hoy') !== '0')) });
  }

  // administración de usuarios (solo admin)
  if (url.pathname === '/api/admin/usuarios') {
    if (!esAdmin(u)) return json(res, 403, { error: 'Solo el administrador' });
    try {
      if (req.method === 'GET') return json(res, 200, { usuarios: listarUsuarios() });
      if (req.method === 'POST') { crearUsuario(await leerBody(req)); return json(res, 200, { usuarios: listarUsuarios() }); }
      if (req.method === 'DELETE') {
        const quien = url.searchParams.get('usuario');
        eliminarUsuario(quien, u.usuario);
        for (const [sid, s] of sesiones) if (s.usuario === quien) sesiones.delete(sid); // cierra sus sesiones
        return json(res, 200, { usuarios: listarUsuarios() });
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  json(res, 404, { error: 'No existe' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); json(res, 500, { error: 'Error interno' }); }
}).listen(PORT, () => console.log(`Panel de ventas en http://localhost:${PORT}`));
