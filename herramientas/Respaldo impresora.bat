@echo off
REM Lanzador del servidor de respaldo de la impresora. Doble clic y listo.
REM Deja esta ventana abierta: mientras esté abierta, la impresora puede respaldar.
title Respaldo impresora - NO CERRAR
cd /d "%~dp0"

python "%~dp0respaldo-servidor.py"

REM Si Python falla o se cierra el servidor, la ventana se queda para poder leer el error.
echo.
echo ----------------------------------------------------------
echo El servidor se ha detenido.
echo.
echo Si pone que no encuentra "python", instalalo desde
echo python.org marcando "Add python.exe to PATH".
echo ----------------------------------------------------------
pause
