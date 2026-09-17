@echo off
REM Wrapper for the minimal PATH of cmd /C that Piebald uses (node is not in it).
REM win-work: Node is a per-user WinGet install (no C:\Program Files\nodejs). stdin is piped to node.
set "NODE_EXE=C:\Users\shiro\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node.exe"
if not exist "%NODE_EXE%" for /f "delims=" %%N in ('where node 2^>nul') do set "NODE_EXE=%%N"
"%NODE_EXE%" "%~dp0pretooluse-route.mjs"
