// Usuarios y sesiones. Los usuarios viven en Neon (tabla bg_usuarios; en Vercel no se pueden guardar archivos)
// y la sesión es una cookie firmada, así no hace falta memoria del servidor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { neon } = require('./db');
const { SEDES } = require('./data');

const hashClave = (clave, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(String(clave), salt, 32).toString('hex') });

// Crea la tabla y, si está vacía, la llena: con data/usuarios.json si existe (migración local) o con el admin de ADMIN_CLAVE.
let listo = null;
const preparar = () => listo || (listo = (async () => {
  await neon.query(`CREATE TABLE IF NOT EXISTS bg_usuarios (
    usuario text PRIMARY KEY, nombre text NOT NULL, sedes jsonb, salt text NOT NULL, hash text NOT NULL)`);
  const { rows } = await neon.query('SELECT count(*)::int AS n FROM bg_usuarios');
  if (rows[0].n) return;
  let semilla = [];
  try { semilla = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'usuarios.json'), 'utf8')); } catch {}
  if (!semilla.length && process.env.ADMIN_CLAVE) semilla = [{ usuario: 'admin', nombre: 'Administrador', sedes: null, ...hashClave(process.env.ADMIN_CLAVE) }];
  if (!semilla.length) console.error('No hay usuarios: define ADMIN_CLAVE para crear el administrador');
  for (const u of semilla) {
    await neon.query('INSERT INTO bg_usuarios (usuario, nombre, sedes, salt, hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [u.usuario, u.nombre, u.sedes ? JSON.stringify(u.sedes) : null, u.salt, u.hash]);
  }
})().catch((e) => { listo = null; throw e; }));

let memo = null; // lista en memoria 15 s para no ir a Neon en cada petición
async function todos() {
  if (memo && Date.now() - memo.t < 15000) return memo.v;
  await preparar();
  const { rows } = await neon.query('SELECT usuario, nombre, sedes, salt, hash FROM bg_usuarios ORDER BY usuario');
  memo = { t: Date.now(), v: rows };
  return rows;
}
const soltar = () => { memo = null; };
const buscar = async (n) => (await todos()).find((x) => x.usuario === String(n || '').trim().toLowerCase());

async function verificar(usuario, clave) {
  const u = await buscar(usuario);
  if (!u) return null;
  const h = Buffer.from(hashClave(clave, u.salt).hash, 'hex');
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')) ? u : null;
}
const listarUsuarios = async () => (await todos()).map(({ usuario, nombre, sedes }) => ({ usuario, nombre, sedes }));

async function crearUsuario({ usuario, nombre, clave, sede }) {
  usuario = String(usuario || '').trim().toLowerCase(); nombre = String(nombre || '').trim().slice(0, 60); clave = String(clave || '');
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new Error('Usuario: 3 a 30 letras minúsculas, números, punto, guion o guion bajo');
  if (!nombre) throw new Error('Escribe el nombre');
  if (clave.length < 6) throw new Error('La clave debe tener al menos 6 caracteres');
  const esAdmin = sede === '*'; // '*' = administrador: ve todas las sedes y puede crear usuarios
  if (!esAdmin && !SEDES.some((s) => s.id === sede)) throw new Error('Elige una sede o «Administrador»');
  soltar();
  if (await buscar(usuario)) throw new Error('Ese usuario ya existe');
  const { salt, hash } = hashClave(clave);
  await neon.query('INSERT INTO bg_usuarios (usuario, nombre, sedes, salt, hash) VALUES ($1,$2,$3,$4,$5)',
    [usuario, nombre, esAdmin ? null : JSON.stringify([sede]), salt, hash]);
  soltar();
}

async function eliminarUsuario(usuario, actual) {
  soltar();
  const lista = await todos();
  const u = lista.find((x) => x.usuario === usuario);
  if (!u) throw new Error('No existe');
  if (u.usuario === actual) throw new Error('No puedes eliminar tu propio usuario');
  if (!u.sedes && lista.filter((x) => !x.sedes).length <= 1) throw new Error('Debe quedar al menos un administrador');
  await neon.query('DELETE FROM bg_usuarios WHERE usuario = $1', [usuario]);
  soltar();
}

// ---- Sesión: cookie "sid" = datos.firma (HMAC). Sin SESSION_SECRET se usa una clave al azar (solo vale en local).
const SECRETO = process.env.SESSION_SECRET || (console.warn('Sin SESSION_SECRET: las sesiones se pierden al reiniciar'), crypto.randomBytes(32).toString('hex'));
const firmar = (s) => crypto.createHmac('sha256', SECRETO).update(s).digest('base64url');
const DURACION_MS = 12 * 3600 * 1000;

function crearSesion(usuario) {
  const datos = Buffer.from(JSON.stringify({ u: usuario, e: Date.now() + DURACION_MS })).toString('base64url');
  return `${datos}.${firmar(datos)}`;
}
// Devuelve el usuario vigente de la cookie, o null. Si borraron al usuario, la sesión deja de valer.
async function usuarioDeSesion(token) {
  const [datos, firma] = String(token || '').split('.');
  if (!datos || !firma) return null;
  const esperada = Buffer.from(firmar(datos)), recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
  let p; try { p = JSON.parse(Buffer.from(datos, 'base64url').toString()); } catch { return null; }
  if (!p || p.e < Date.now()) return null;
  const u = await buscar(p.u);
  return u ? { usuario: u.usuario, nombre: u.nombre, sedes: u.sedes } : null;
}

module.exports = { verificar, listarUsuarios, crearUsuario, eliminarUsuario, crearSesion, usuarioDeSesion, DURACION_MS };
