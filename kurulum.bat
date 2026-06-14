@echo off
setlocal enabledelayedexpansion

:: Log dosyasi - terminal kapanirsa buradan oku
set "LOG=%~dp0kurulum-log.txt"
echo BasketScrape Kurulum - %date% %time% > "%LOG%"
echo. >> "%LOG%"

:: Kaynak klasor (bu bat'in oldugu yer)
set "KAYNAK=%~dp0"
if "%KAYNAK:~-1%"=="\" set "KAYNAK=%KAYNAK:~0,-1%"
for %%I in ("%KAYNAK%") do set "PARENT=%%~dpI"
if "%PARENT:~-1%"=="\" set "PARENT=%PARENT:~0,-1%"

:: Olusturulacak portlar
set PORTS=3020 3030 3040 3050

echo.
echo ================================================
echo  BasketScrape - Coklu Ornek Kurulumu
echo  Kaynak : %KAYNAK%
echo  Log    : %LOG%
echo ================================================
echo.

for %%P in (%PORTS%) do (
    set "HEDEF=%PARENT%\basketscrape-%%P"

    echo [%%P] Hedef: !HEDEF!
    echo [%%P] Hedef: !HEDEF! >> "%LOG%"

    if exist "!HEDEF!\src\server.js" (
        echo [%%P] Zaten kurulu, atlaniyor.
        echo [%%P] Zaten kurulu >> "%LOG%"
    ) else (
        echo [%%P] Dosyalar kopyalaniyor...
        echo [%%P] robocopy basladi >> "%LOG%"
        robocopy "%KAYNAK%" "!HEDEF!" /E /XD node_modules .git /NP /NFL /NDL /NJH /NJS >> "%LOG%" 2>&1
        echo [%%P] robocopy bitti, errorlevel=%errorlevel% >> "%LOG%"

        echo [%%P] Port degistiriliyor 3010 -^> %%P ...
        powershell -NoProfile -Command "(Get-Content '!HEDEF!\src\server.js' -Raw) -replace '\b3010\b', '%%P' | Set-Content '!HEDEF!\src\server.js' -Encoding UTF8"
        if errorlevel 1 (
            echo [%%P] HATA: Port degistirme basarisiz >> "%LOG%"
        ) else (
            echo [%%P] Port degistirildi >> "%LOG%"
        )

        echo [%%P] start.bat yaziliyor...
        call :YazStartBat "!HEDEF!" %%P
        echo [%%P] start.bat yazildi >> "%LOG%"

        echo [%%P] npm install basliyor... (birkac dakika surebilir)
        echo [%%P] npm install basliyor >> "%LOG%"
        cd /d "!HEDEF!"
        call npm install --loglevel=warn >> "%LOG%" 2>&1
        echo [%%P] npm install bitti, errorlevel=%errorlevel% >> "%LOG%"
        cd /d "%KAYNAK%"

        echo [%%P] TAMAM -^> http://localhost:%%P
        echo [%%P] TAMAM >> "%LOG%"
    )
    echo.
)

echo ================================================
echo  Kurulum tamamlandi!
echo.
echo  Log dosyasi icin: %LOG%
echo.
echo  Her ornegi baslatmak icin start.bat calistir:
for %%P in (%PORTS%) do (
    echo    %PARENT%\basketscrape-%%P\start.bat
)
echo ================================================
echo.
pause
exit /b 0


:: Yardimci: start.bat yaz
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
