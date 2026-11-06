# BusinessGoal

Ventas y metas por sede (Limablue). Cada usuario ve solo su sede; el administrador ve todas y crea usuarios.

```
 Kairos (red local) ──► agente/push.js (tu PC) ──► Neon ◄── Vercel (web: public/ + api/)
```

- **agente/**: corre en una PC con acceso a Kairos (`Correr-Agente.bat`). Cada 2 min sube los datos resumidos a Neon (`bg_snapshot`).
- **Web (Vercel)**: nunca toca Kairos. Lee `bg_snapshot`, `metas_sede` y `bg_usuarios` de Neon. Sesión = cookie firmada.

## Variables
Ver `.env.example`.
- **Vercel**: `NEON_URL`, `SESSION_SECRET` (texto largo al azar). `ADMIN_CLAVE` solo si Neon aún no tiene usuarios.
- **Agente (.env local)**: `KAIROS_*`, `NEON_URL`.

## Local
`npm install`, luego `npm start` (web en :3100) y `npm run agente` (agente).
