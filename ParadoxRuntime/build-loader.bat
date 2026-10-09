@echo off
setlocal
REM Builds the winmm.dll proxy that loads MysticParadox.dll (tools\RuntimeLoader). The crate's
REM library is named winmm, so cargo writes target\release\winmm.dll directly.
pushd "%~dp0..\tools\RuntimeLoader"
if errorlevel 1 exit /b 1
cargo build --release
if errorlevel 1 (
  popd
  exit /b 1
)
if not exist "target\release\winmm.dll" (
  echo target\release\winmm.dll was not produced.
  popd
  exit /b 1
)
popd
exit /b 0
