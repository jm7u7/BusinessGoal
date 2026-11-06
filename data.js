// Capa de datos de la web: lee todo de Neon (ventas y paquetes los sube el agente desde Kairos; metas en metas_sede).
const { neon } = require('./db');

// id de sede de la plataforma -> códigos c_u_negocio de Kairos (Lince = Limablue 003 + Botica 007, como el reporte semanal)
const SEDES = [
  { id: 'lince', nombre: 'Lince', codigos: ['003', '007'], metaCodigo: '003' },
  { id: 'sanisidro', nombre: 'San Isidro', codigos: ['004'], metaCodigo: '004' },
  { id: 'losolivos', nombre: 'Los Olivos', codigos: ['006'], metaCodigo: '006' },
  { id: 'sanmiguel', nombre: 'San Miguel', codigos: ['005'], metaCodigo: '005' },
  { id: 'one', nombre: 'One', codigos: ['008'], metaCodigo: '008' },
];

// Solo las sedes de esta lista tienen meta de sesiones. San Isidro (Paz Soldán) y One NO llevan meta ni contabilizan nada
// (tienen el área de fisioterapia como tal). Para agregar una sede: sedeId: { tipo: 'L' o 'F', meta: n }.
const PAQUETE_SEDE = {
  lince: { tipo: 'L', meta: 5 }, losolivos: { tipo: 'L', meta: 5 }, sanmiguel: { tipo: 'L', meta: 5 },
};

const diasDelMes = (a, m) => new Date(a, m, 0).getDate();
const pad = (n) => String(n).padStart(2, '0');

// cache corto: en Vercel vive mientras la instancia esté tibia
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Lo que dejó el agente: { datos, actualizado }. Si todavía no hay nada, devuelve el valor vacío.
async function snapshot(clave, vacio) {
  return cached(`s:${clave}`, 20000, async () => {
    try {
      const r = await neon.query('SELECT datos, actualizado FROM bg_snapshot WHERE clave = $1', [clave]);
      return r.rows[0] ? { datos: r.rows[0].datos, actualizado: r.rows[0].actualizado } : { datos: vacio, actualizado: null };
    } catch { return { datos: vacio, actualizado: null }; }
  });
}
const ventasMes = async (a, m) => (await snapshot(`ventas-${a}-${pad(m)}`, {})).datos; // dia -> cod -> monto
const laserMes = async (a, m) => (await snapshot(`laser-${a}-${pad(m)}`, {})).datos; // dia -> cod -> { L, F }
const paquetesDetalle = async (a, m) => (await snapshot(`detalle-${a}-${pad(m)}`, [])).datos;
// Cuándo subió datos el agente por última vez (para avisar si se quedó parado)
async function ultimaActualizacion() {
  const r = await snapshot('estado', {});
  return r.actualizado;
}

async function metasMes(anio, mes) {
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

module.exports = { PAQUETE_SEDE, SEDES, laserMes, paquetesDetalle, ventasDiarias, metaMes, diasDelMes, ultimaActualizacion };
