@echo off
chcp 65001 >nul
title 下载 llama-server.exe

echo.
echo ================================================================
echo           下载 llama-server.exe (本地 LLM)
echo ================================================================
echo.

set DOWNLOAD_URL=https://github.com/ggerganov/llama.cpp/releases/download/b4246/llama-b4246-bin-win-avx2-x64.zip
set ZIP_FILE=llama-server.zip
set EXTRACT_DIR=llama-server
set TARGET_DIR=..\models\local-llm

echo [1/4] 下载 llama-server...
if not exist "%ZIP_FILE%" (
    echo   正在从 GitHub 下载...
    curl -L -o "%ZIP_FILE%" "%DOWNLOAD_URL%"
    if errorlevel 1 (
        echo   [ERROR] 下载失败！
        pause
        exit /b 1
    )
    echo   [OK] 下载完成
) else (
    echo   [SKIP] 文件已存在
)

echo.
echo [2/4] 解压文件...
if not exist "%EXTRACT_DIR%" (
    echo   正在解压...
    powershell -Command "Expand-Archive -Path '%ZIP_FILE%' -DestinationPath '%EXTRACT_DIR%' -Force"
    if errorlevel 1 (
        echo   [ERROR] 解压失败！
        pause
        exit /b 1
    )
    echo   [OK] 解压完成
) else (
    echo   [SKIP] 已解压
)

echo.
echo [3/4] 复制到目标目录...
if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%"
)
copy /Y "%EXTRACT_DIR%\*.exe" "%TARGET_DIR%\" >nul 2>&1
if errorlevel 1 (
    echo   [ERROR] 复制失败！
    pause
    exit /b 1
)
echo   [OK] 复制完成

echo.
echo [4/4] 清理临时文件...
del /Q "%ZIP_FILE%" >nul 2>&1
rmdir /S /Q "%EXTRACT_DIR%" >nul 2>&1
echo   [OK] 清理完成

echo.
echo ================================================================
echo           llama-server.exe 安装完成！
echo ================================================================
echo.
echo   位置: %TARGET_DIR%\llama-server.exe
echo   模型: %TARGET_DIR%\..\qwen3-0.6b\Qwen3-0.6B-Q8_0.gguf
echo.
echo   现在可以在 Manager 中启动 Local LLM 了！
echo ================================================================
echo.
pause
