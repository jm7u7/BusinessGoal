const crypto = require('crypto');
const { PAQUETE_SEDE, laserMes, paquetesDetalle, SEDES, ventasDiarias, metaMes, ultimaActualizacion } = require('./data');
const { verificar, listarUsuarios, crearUsuario, eliminarUsuario, crearSesion, usuarioDeSesion, DURACION_MS } = require('./usuarios');

const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};
const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
const esAdmin = (u) => !u.sedes;
const sedesPermitidas = (u) => (u.sedes ? u.sedes : SEDES.map((s) => s.id));
// Fechas en hora de Perú (el servidor de Vercel está en UTC)
const fmtLima = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' });
const hoyLima = (offDias = 0) => fmtLima.format(new Date(Date.now() + offDias * 864e5));
const hoyLocal = () => hoyLima(0);
const cookieSid = (req, valor, maxAge) =>
  `sid=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

function leerBody(req) {
  return new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
}

// incluirHoy=false: no cuentan las ventas de hoy (el corte pasa a ayer). Los domingos siempre cuentan.
async function resumen(anio, mes, sedes, incluirHoy) {
  const hoy = incluirHoy ? hoyLocal() : hoyLima(-1);
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
    const u = await verificar(usuario, clave);
    if (!u) return json(res, 401, { error: 'Usuario o clave incorrectos' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSid(req, crearSesion(u.usuario), DURACION_MS / 1000) });
  }
  if (url.pathname === '/api/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieSid(req, '', 0) });
  }
  const u = await usuarioDeSesion(cookie(req).sid);
  if (!u) return json(res, 401, { error: 'No autenticado' });

  if (url.pathname === '/api/me') {
    const ids = sedesPermitidas(u);
    return json(res, 200, { nombre: u.nombre, usuario: u.usuario, admin: esAdmin(u), sedes: SEDES.filter((s) => ids.includes(s.id)).map(({ id, nombre }) => ({ id, nombre })), hoy: hoyLocal() });
  }
  if (url.pathname === '/api/ventas') {
    const q = url.searchParams;
    const anio = 2026; // el panel trabaja solo con 2026
    const mes = Math.min(12, Math.max(1, +q.get('mes') || +hoyLocal().slice(5, 7)));
    const permitidas = sedesPermitidas(u);
    // El servidor impone el filtro: nunca confía en lo que pida el navegador.
    let pedidas = (q.get('sedes') || '').split(',').filter(Boolean);
    pedidas = pedidas.length ? pedidas.filter((s) => permitidas.includes(s)) : permitidas;
    if (!pedidas.length) pedidas = permitidas;
    return json(res, 200, { sedes: pedidas, actualizado: await ultimaActualizacion(), ...(await resumen(anio, mes, pedidas, q.get('hoy') !== '0')) });
  }

  // administración de usuarios (solo admin)
  if (url.pathname === '/api/admin/usuarios') {
    if (!esAdmin(u)) return json(res, 403, { error: 'Solo el administrador' });
    try {
      if (req.method === 'GET') return json(res, 200, { usuarios: await listarUsuarios() });
      if (req.method === 'POST') { await crearUsuario(await leerBody(req)); return json(res, 200, { usuarios: await listarUsuarios() }); }
      if (req.method === 'DELETE') {
        const quien = url.searchParams.get('usuario');
        await eliminarUsuario(quien, u.usuario); // sus sesiones dejan de valer: la cookie se valida contra la tabla
        return json(res, 200, { usuarios: await listarUsuarios() });
      }
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  json(res, 404, { error: 'No existe' });
}


module.exports = { api, json };
