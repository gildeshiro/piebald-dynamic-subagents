@echo off
REM Wrapper p/ o PATH minimo do cmd /C que o Piebald usa (node nao esta nele).
REM Path 8.3 evita o espaco em "Program Files". stdin flui pro node.
"C:\PROGRA~1\nodejs\node.exe" "%~dp0pretooluse-route.mjs"
