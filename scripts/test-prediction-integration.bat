@echo off
chcp 65001 >nul
echo ========================================
echo Prediction integration script retired
echo ========================================
echo.
echo The old public prediction endpoints on Memory Universe are no longer part of
echo the default unified runtime surface.
echo.
echo Use these checks instead:
echo   1. start-unified.bat
echo   2. curl http://localhost:8080/api/runtime/overview
echo   3. curl -X POST http://localhost:8080/api/chat -H "Content-Type: application/json" -d "{\"session_id\":\"prediction-retired\",\"user_id\":\"operator\",\"text\":\"status\"}"
echo.
echo For deeper runtime validation, run:
echo   npm run smoke
echo   npm run unified:test
echo.
exit /b 0
