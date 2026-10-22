@echo off
cd /d "%~dp0"
:loop
ssh -i 服务器钥匙 -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -R 80:localhost:3000 plan@localhost.run
timeout /t 3 >nul
goto loop
