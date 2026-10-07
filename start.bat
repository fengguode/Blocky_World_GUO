@echo off
title Blocky World - local server
echo.
echo   Starting the game server...
echo   Keep this window open while the family plays.
echo.
cd /d "%~dp0"
node serve.js
pause
