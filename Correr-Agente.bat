@echo off
cd /d "%~dp0"
if not exist node_modules ( call npm install )
echo Agente BusinessGoal: Kairos -^> Neon (Ctrl+C para detener)
node agente\push.js
pause
