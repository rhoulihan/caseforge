@echo off
REM Double-click this file to start CaseForge. It opens your web browser automatically.
REM (First time: if Windows shows a blue "protected your PC" box, click "More info" then "Run anyway".)
cd /d "%~dp0"
caseforge.exe serve --app-dir dist
echo.
echo CaseForge has stopped. You can close this window.
pause
