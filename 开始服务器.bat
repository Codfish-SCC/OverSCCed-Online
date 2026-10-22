@echo off
rem OverSCCed 一键开服（Windows 版）
rem 需要：1) 安装 Node.js (https://nodejs.org)  2) Windows 10+ 自带 ssh
cd /d "%~dp0"
echo OverSCCed 开服中… 会弹出第二个窗口跑隧道，两个都别关
echo 网址（永久不变）: https://28bbae9c6a35d8.lhr.life
echo.
start "OverSCCed隧道" cmd /c "隧道.bat"
:loop
node server\server.js 3000
timeout /t 2 >nul
goto loop
