@echo off
setlocal EnableExtensions EnableDelayedExpansion
title BasketScrape Kurulum
chcp 65001 >nul

:: ============================================================
::  BasketScrape - tek dosyalik kurulum
::  Bu dosyayi indirip cift tiklamaniz yeterli:
::   1. Node.js yoksa kurar
::   2. Programi GitHub'dan indirir ve gerekli paketleri kurar
::   3. Masaustune "BasketScrape" simgesi koyar ve programi acar
::  Program her acilista GitHub'dan guncellemeleri kendisi alir.
:: ============================================================

set "REPO=aral-by/basketscrape"
if not defined BASKETSCRAPE_BRANCH set "BASKETSCRAPE_BRANCH=main"
set "APPDIR=%LOCALAPPDATA%\BasketScrape"

echo.
echo  ================================================
echo   BasketScrape kuruluyor
echo   Klasor: %APPDIR%
echo  ================================================
echo.

:: ---- 1. Node.js ------------------------------------------------
call :findnode
if defined NODE (
    "!NODE!" -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" || set "NODE="
)
if not defined NODE (
    echo  [1/4] Node.js kuruluyor...
    where winget >nul 2>nul && (
        winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    )
    call :findnode
)
if not defined NODE (
    echo  [1/4] Node.js nodejs.org'dan indiriliyor...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
      "$v=(Invoke-RestMethod https://nodejs.org/dist/index.json | Where-Object { $_.lts } | Select-Object -First 1).version;" ^
      "Invoke-WebRequest -UseBasicParsing \"https://nodejs.org/dist/$v/node-$v-x64.msi\" -OutFile \"$env:TEMP\node-lts.msi\""
    if exist "%TEMP%\node-lts.msi" msiexec /i "%TEMP%\node-lts.msi" /passive /norestart
    call :findnode
)
if not defined NODE (
    echo.
    echo  HATA: Node.js kurulamadi. https://nodejs.org adresinden "LTS" surumunu kurup
    echo  bu dosyayi tekrar calistirin.
    pause
    exit /b 1
)
echo  [1/4] Node.js hazir: !NODE!
set "PATH=!NODEDIR!;%PATH%"

:: ---- 2. Guncelleyiciyi indir --------------------------------------
echo  [2/4] Program indiriliyor...
if not exist "%APPDIR%\scripts" mkdir "%APPDIR%\scripts"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
  "Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/%REPO%/%BASKETSCRAPE_BRANCH%/scripts/update.js' -OutFile '%APPDIR%\scripts\update.js'"
if not exist "%APPDIR%\scripts\update.js" (
    echo  HATA: GitHub'a ulasilamadi. Internet baglantinizi kontrol edin.
    pause
    exit /b 1
)

:: ---- 3. Programi ve paketleri kur ----------------------------------
echo  [3/4] Paketler kuruluyor (ilk seferde birkac dakika surer, lutfen bekleyin)...
"!NODE!" "%APPDIR%\scripts\update.js" --dir "%APPDIR%" --force
if errorlevel 1 (
    echo  HATA: Kurulum tamamlanamadi. Bu pencerenin ekran goruntusunu gonderin.
    pause
    exit /b 1
)

:: ---- 4. Masaustu ve Baslat menusu simgesi ---------------------------
echo  [4/4] Masaustu simgesi olusturuluyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w=New-Object -ComObject WScript.Shell;" ^
  "foreach($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))){" ^
  " $s=$w.CreateShortcut((Join-Path $d 'BasketScrape.lnk'));" ^
  " $s.TargetPath='%APPDIR%\BasketScrape.bat'; $s.WorkingDirectory='%APPDIR%';" ^
  " $s.IconLocation='%APPDIR%\public\icon.ico'; $s.WindowStyle=7;" ^
  " $s.Description='BasketScrape - canli MS tahmini'; $s.Save() }"

echo.
echo  ================================================
echo   Kurulum tamamlandi!
echo   Masaustundeki "BasketScrape" simgesiyle acabilirsiniz.
echo   Program simdi aciliyor...
echo  ================================================
echo.
start "" "%APPDIR%\BasketScrape.bat"
timeout /t 5 >nul
exit /b 0

:findnode
set "NODE="
set "NODEDIR="
for %%P in (node.exe) do if not "%%~$PATH:P"=="" set "NODE=%%~$PATH:P"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODE for %%D in ("!NODE!") do set "NODEDIR=%%~dpD"
exit /b 0
