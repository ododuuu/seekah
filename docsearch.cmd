@echo off
node "%~dp0dist\src\cli.js" %*
exit /b %errorlevel%
