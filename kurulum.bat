@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

:: ─── Kaynak: bu bat'in bulundugu klasor ───────────────────────────
set "KAYNAK=%~dp0"
if "%KAYNAK:~-1%"=="\" set "KAYNAK=%KAYNAK:~0,-1%"
for %%I in ("%KAYNAK%") do set "PARENT=%%~dpI"
if "%PARENT:~-1%"=="\" set "PARENT=%PARENT:~0,-1%"

:: ─── Olusturulacak portlar (mevcut: 3010) ─────────────────────────
set PORTS=3020 3030 3040 3050

echo.
echo  ================================================
echo   BasketScrape - Coklu Ornek Kurulumu
echo   Kaynak : %KAYNAK%
echo   Hedef  : %PARENT%\basketscrape-XXXX
echo  ================================================
echo.

for %%P in (%PORTS%) do (
    set "HEDEF=%PARENT%\basketscrape-%%P"

    echo [%%P] -----------------------------------------
    if exist "!HEDEF!\src\server.js" (
        echo [%%P] Zaten kurulu, atlaniyor.
    ) else (
        echo [%%P] Klasor olusturuluyor...
        robocopy "%KAYNAK%" "!HEDEF!" /E /XD node_modules .git /NP /NFL /NDL /NJH /NJS > nul

        echo [%%P] Port degistiriliyor  3010 -^> %%P ...
        powershell -NoProfile -Command "(Get-Content '!HEDEF!\src\server.js' -Raw) -replace '\b3010\b', '%%P' | Set-Content '!HEDEF!\src\server.js' -Encoding UTF8"

        echo [%%P] start.bat yaziliyor...
        call :YazStartBat "!HEDEF!" %%P

        echo [%%P] npm install calisiyor  ^(ilk seferde uzun surebilir^)...
        cd /d "!HEDEF!"
        call npm install --loglevel=warn
        cd /d "%KAYNAK%"

        echo [%%P] TAMAM  -^>  http://localhost:%%P
    )
    echo.
)

echo  ================================================
echo   Kurulum tamamlandi!
echo.
echo   Her ornegi baslatmak icin ilgili klasordeki
echo   start.bat dosyasini calistir:
echo.
for %%P in (%PORTS%) do (
    echo     %PARENT%\basketscrape-%%P\start.bat
)
echo  ================================================
echo.
pause
exit /b 0


:: ─── Yardimci: start.bat icerigi yaz ─────────────────────────────
:YazStartBat
set "_DIR=%~1"
set "_PORT=%~2"
(
    echo @echo off
    echo title BasketScrape - Port %_PORT%
    echo cd /d "%%~dp0"
    echo echo.
    echo echo  Sunucu baslatiliyor: http://localhost:%_PORT%
    echo echo.
    echo node src/server.js
    echo pause
) > "%_DIR%\start.bat"
goto :eof
