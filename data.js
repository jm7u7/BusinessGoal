// Capa de datos real: ventas desde ERP Kairos (Postgres) y metas desde Neon (tabla metas_sede,
// la misma que llena PanelCitas/ads-service/import-metas.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Carga .env simple (sin dependencia extra)
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const kairos = new Pool({
  host: process.env.KAIROS_HOST, port: +(process.env.KAIROS_PORT || 5432),
  database: process.env.KAIROS_DB || 'erp_kairos', user: process.env.KAIROS_USER, password: process.env.KAIROS_PASSWORD,
  max: 3, connectionTimeoutMillis: 8000,
});
const neon = process.env.NEON_URL ? new Pool({ connectionString: process.env.NEON_URL, ssl: { rejectUnauthorized: false }, max: 2 }) : null;

// id de sede de la plataforma -> códigos c_u_negocio de Kairos (Lince = Limablue 003 + Botica 007, como el reporte semanal)
const SEDES = [
  { id: 'lince', nombre: 'Lince', codigos: ['003', '007'], metaCodigo: '003' },
  { id: 'sanisidro', nombre: 'San Isidro', codigos: ['004'], metaCodigo: '004' },
  { id: 'losolivos', nombre: 'Los Olivos', codigos: ['006'], metaCodigo: '006' },
  { id: 'sanmiguel', nombre: 'San Miguel', codigos: ['005'], metaCodigo: '005' },
  { id: 'one', nombre: 'One', codigos: ['008'], metaCodigo: '008' },
];

// Usuarios guardados en data/usuarios.json (claves con scrypt + sal). sedes:null = administrador, ve todas.
const USERS_FILE = path.join(__dirname, 'data', 'usuarios.json');
const hashClave = (clave, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(clave), salt, 32).toString('hex') });
function cargarUsuarios() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
  // primera vez: usuarios de demostración (cambiar claves desde el panel de administración)
  const base = [
    ['admin', 'Administrador', 'admin123', null], ['lince', 'Gerente Lince', 'lince123', ['lince']],
    ['sanisidro', 'Gerente San Isidro', 'sanisidro123', ['sanisidro']], ['losolivos', 'Gerente Los Olivos', 'olivos123', ['losolivos']],
    ['sanmiguel', 'Gerente San Miguel', 'miguel123', ['sanmiguel']], ['one', 'Gerente One', 'one123', ['one']],
  ].map(([usuario, nombre, c, sedes]) => ({ usuario, nombre, sedes, ...hashClave(c) }));
  guardarUsuarios(base);
  return base;
}
function guardarUsuarios(u) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  try { fs.copyFileSync(USERS_FILE, USERS_FILE + '.bak'); } catch {} // copia de la versión anterior
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
  fs.renameSync(tmp, USERS_FILE); // escritura atómica: nunca queda un archivo a medias
}
let usuarios = cargarUsuarios();
const buscarUsuario = (n) => usuarios.find((x) => x.usuario === String(n || '').toLowerCase());
function verificar(usuario, clave) {
  const u = buscarUsuario(usuario);
  if (!u) return null;
  const h = Buffer.from(hashClave(clave, u.salt).hash, 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')) ? u : null;
}
const listarUsuarios = () => usuarios.map(({ usuario, nombre, sedes }) => ({ usuario, nombre, sedes }));
function crearUsuario({ usuario, nombre, clave, sede }) {
  usuario = String(usuario || '').trim().toLowerCase(); nombre = String(nombre || '').trim().slice(0, 60); clave = String(clave || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new Error('Usuario: 3 a 30 letras minúsculas, números, punto, guion o guion bajo');
  if (!nombre) throw new Error('Escribe el nombre');
  if (clave.length < 6) throw new Error('La clave debe tener al menos 6 caracteres');
  const esAdmin = sede === '*'; // '*' = administrador: ve todas las sedes y puede crear usuarios
  if (!esAdmin && !SEDES.some((s) => s.id === sede)) throw new Error('Elige una sede o «Administrador»');
  if (buscarUsuario(usuario)) throw new Error('Ese usuario ya existe');
  usuarios.push({ usuario, nombre, sedes: esAdmin ? null : [sede], ...hashClave(clave) });
  guardarUsuarios(usuarios);
}
function eliminarUsuario(usuario, actual) {
  const u = buscarUsuario(usuario);
  if (!u) throw new Error('No existe');
  if (u.usuario === actual) throw new Error('No puedes eliminar tu propio usuario');
  if (!u.sedes && usuarios.filter((x) => !x.sedes).length <= 1) throw new Error('Debe quedar al menos un administrador');
  usuarios = usuarios.filter((x) => x !== u);
  guardarUsuarios(usuarios);
}

const diasDelMes = (a, m) => new Date(a, m, 0).getDate();
const pad = (n) => String(n).padStart(2, '0');

// cache corto para no golpear el ERP en cada clic
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Ventas por día y sede del mes (con IGV, comprobantes no anulados, sin duplicar comprobantes)
async function ventasMes(anio, mes) {
  return cached(`v${anio}-${mes}`, 60000, async () => {
    const desde = `${anio}-${pad(mes)}-01`;
    const r = await kairos.query(
      `SELECT dia, c_u_negocio AS cod, SUM(tot_venta) AS monto FROM (
         SELECT DISTINCT ON (v.c_u_negocio, v.ndocumento_cpe, v.f_emision)
                to_char(v.f_emision,'YYYY-MM-DD') AS dia, v.c_u_negocio, v.tot_venta
         FROM modelo.venta_registro v
         WHERE v.s_anulado = 0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
       ) x GROUP BY dia, c_u_negocio`, [desde]);
    const mapa = {}; // dia -> cod -> monto
    for (const x of r.rows) (mapa[x.dia] || (mapa[x.dia] = {}))[x.cod] = Number(x.monto);
    return mapa;
  });
}

// Paquetes de 6 sesiones. Meta mensual por sede. Ajustar aquí si cambia el criterio.
//  L = láser de fisioterapia: LASERTERAPIA P6 + INDOMETACINA (fascitis, juanete, metatarso, talón, tríceps sural)
//  F = fisioterapia en paquete de 6: FISIOTERAPIA P6 (la venden San Isidro y One)
const PATRON_L = '%LASERTERAPIA P6 + INDOMETACINA%';
const PATRON_F = '%FISIOTERAPIA P6%';
// Solo las sedes de esta lista tienen meta de sesiones. San Isidro (Paz Soldán) y One NO llevan meta ni contabilizan nada
// (tienen el área de fisioterapia como tal). Para agregar una sede: sedeId: { tipo: 'L' o 'F', meta: n }.
const PAQUETE_SEDE = {
  lince: { tipo: 'L', meta: 5 }, losolivos: { tipo: 'L', meta: 5 }, sanmiguel: { tipo: 'L', meta: 5 },
};
async function laserMes(anio, mes) {
  return cached(`l${anio}-${mes}`, 60000, async () => {
    const desde = `${anio}-${pad(mes)}-01`;
    const r = await kairos.query(
      `SELECT to_char(v.f_emision,'YYYY-MM-DD') AS dia, v.c_u_negocio AS cod,
              CASE WHEN upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 THEN 'L' ELSE 'F' END AS tipo, SUM(i.cantidad) AS cant
       FROM modelo.venta_registro_item i
       JOIN modelo.venta_registro v ON v.c_empresa=i.c_empresa AND v.c_u_negocio=i.c_u_negocio AND v.anomes=i.anomes AND v.ndocumento_cpe=i.ndocumento_cpe
       LEFT JOIN modelo.m_producto_bs p ON p.c_empresa=i.c_empresa AND p.c_producto_bs=i.c_producto_bs
       WHERE i.s_anulado=0 AND v.s_anulado=0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
         AND (upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 OR upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $3)
       GROUP BY 1,2,3`, [desde, PATRON_L, PATRON_F]);
    const mapa = {}; // dia -> cod -> { L, F }
    for (const x of r.rows) ((mapa[x.dia] || (mapa[x.dia] = {}))[x.cod] || (mapa[x.dia][x.cod] = {}))[x.tipo] = Number(x.cant);
    return mapa;
  });
}

// Detalle de cada venta de los paquetes (para la tabla): fecha, sede, producto, cantidad, importe y comprobante.
async function paquetesDetalle(anio, mes) {
  return cached(`pd${anio}-${mes}`, 60000, async () => {
    const desde = `${anio}-${pad(mes)}-01`;
    const r = await kairos.query(
      `SELECT to_char(v.f_emision,'YYYY-MM-DD') AS fecha, v.c_u_negocio AS cod,
              upper(trim(coalesce(p.d_producto_bs, i.glosa, ''))) AS producto,
              CASE WHEN upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 THEN 'L' ELSE 'F' END AS tipo,
              i.cantidad AS cant, i.tot_venta_item AS monto,
              coalesce(v.s_cpe::text,'') || '-' || coalesce(v.n_cpe::text,'') AS doc
       FROM modelo.venta_registro_item i
       JOIN modelo.venta_registro v ON v.c_empresa=i.c_empresa AND v.c_u_negocio=i.c_u_negocio AND v.anomes=i.anomes AND v.ndocumento_cpe=i.ndocumento_cpe
       LEFT JOIN modelo.m_producto_bs p ON p.c_empresa=i.c_empresa AND p.c_producto_bs=i.c_producto_bs
       WHERE i.s_anulado=0 AND v.s_anulado=0 AND v.f_emision >= $1::date AND v.f_emision < ($1::date + interval '1 month')
         AND (upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $2 OR upper(coalesce(p.d_producto_bs, i.glosa, '')) LIKE $3)
       ORDER BY v.f_emision DESC, v.ndocumento_cpe DESC`, [desde, PATRON_L, PATRON_F]);
    return r.rows.map((x) => ({ ...x, cant: Number(x.cant), monto: Number(x.monto) }));
  });
}

async function metasMes(anio, mes) {
  if (!neon) return {};
  return cached(`m${anio}-${mes}`, 300000, async () => {
    try {
      const r = await neon.query('SELECT sede, meta FROM metas_sede WHERE mes = $1', [`${anio}-${pad(mes)}`]);
      return Object.fromEntries(r.rows.map((x) => [x.sede, Number(x.meta)]));
    } catch { return {}; }
  });
}

async function ventasDiarias(anio, mes, sedes, hoy) {
  const mapa = await ventasMes(anio, mes);
  const cods = SEDES.filter((s) => sedes.includes(s.id)).flatMap((s) => s.codigos);
  const out = [];
  for (let d = 1; d <= diasDelMes(anio, mes); d++) {
    const fecha = `${anio}-${pad(mes)}-${pad(d)}`;
    if (fecha > hoy) { out.push({ dia: d, fecha, venta: null }); continue; }
    out.push({ dia: d, fecha, venta: cods.reduce((t, c) => t + ((mapa[fecha] || {})[c] || 0), 0) });
  }
  return out;
}

async function metaMes(anio, mes, sedes) {
  const m = await metasMes(anio, mes);
  return SEDES.filter((s) => sedes.includes(s.id)).reduce((t, s) => t + (m[s.metaCodigo] || 0), 0);
}

module.exports = { PAQUETE_SEDE, laserMes, paquetesDetalle, SEDES, verificar, listarUsuarios, crearUsuario, eliminarUsuario, ventasDiarias, metaMes, diasDelMes };
