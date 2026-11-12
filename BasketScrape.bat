@echo off
setlocal EnableExtensions EnableDelayedExpansion
title BasketScrape - bu pencereyi KAPATMAYIN (kapatinca program durur)
chcp 65001 >nul
cd /d "%~dp0"

set "NODE="
for %%P in (node.exe) do if not "%%~$PATH:P"=="" set "NODE=%%~$PATH:P"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
    echo Node.js bulunamadi. Lutfen BasketScrape-Kurulum.bat dosyasini tekrar calistirin.
    pause
    exit /b 1
)
for %%D in ("!NODE!") do set "PATH=%%~dpD;%PATH%"

"!NODE!" scripts\launch.js
if errorlevel 1 pause
