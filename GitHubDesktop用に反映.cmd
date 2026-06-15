@echo off
cd /d "%~dp0"
set "SRC=%~dp0"
set "DEST=c:\Users\gtechno\Desktop\desktop-tutorial"
if not exist "%DEST%\" (
  echo desktop-tutorial フォルダが見つかりません。
  pause
  exit /b 1
)
copy /Y "%SRC%viewer.html" "%DEST%\viewer.html"
copy /Y "%SRC%look.html" "%DEST%\look.html"
copy /Y "%SRC%map.html" "%DEST%\map.html"
copy /Y "%SRC%index.html" "%DEST%\index.html"
copy /Y "%SRC%data.js" "%DEST%\data.js"
if not exist "%DEST%\help\" mkdir "%DEST%\help"
copy /Y "%SRC%地図の取説\取説設定.js" "%DEST%\help\config.js"
copy /Y "%SRC%help\index.html" "%DEST%\help\index.html"
copy /Y "%SRC%help\help-engine.js" "%DEST%\help\help-engine.js"
copy /Y "%SRC%help\help.css" "%DEST%\help\help.css"
echo.
echo desktop-tutorial に反映しました。
echo.
echo 次: GitHub Desktop を開く
echo   1. desktop-tutorial が選ばれているか確認
echo   2. 変更一覧に help フォルダなどが出ているか確認
echo   3. Summary に「取説を追加」などと書いて Commit
echo   4. Push origin をクリック
echo.
pause
