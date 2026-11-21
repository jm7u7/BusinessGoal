@echo off
cd /d "%~dp0"
title BusinessGoal local
:r
node server.js
timeout /t 5 >nul
goto r
