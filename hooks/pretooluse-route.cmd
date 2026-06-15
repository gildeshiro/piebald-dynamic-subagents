@echo off
REM Wrapper for the minimal PATH of cmd /C that Piebald uses (node is not in it).
REM 8.3 path avoids the space in "Program Files". stdin is piped to node.
"C:\PROGRA~1\nodejs\node.exe" "%~dp0pretooluse-route.mjs"
