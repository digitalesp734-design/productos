@echo off
echo Iniciando Product Digital...

start "Servidor" cmd /k "cd /d C:\Users\Lenovo\Downloads\product-digital\server && node src/app.js"
timeout /t 2 /nobreak >nul
start "Cliente" cmd /k "cd /d C:\Users\Lenovo\Downloads\product-digital\client && npm run dev"

timeout /t 3 /nobreak >nul
start "" "http://localhost:5173"
