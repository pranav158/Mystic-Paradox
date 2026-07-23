@echo off
setlocal
REM Portable build: locate MSBuild via vswhere (ships with VS 2017+). No hardcoded VS path.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
set "MSBUILD="
if exist "%VSWHERE%" for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe`) do set "MSBUILD=%%i"
if not defined MSBUILD (
  echo Could not locate MSBuild automatically.
  echo Open a "Developer Command Prompt for VS" and run:
  echo   msbuild CatalogExporter.vcxproj /p:Configuration=Release /p:Platform=x64
  exit /b 1
)
"%MSBUILD%" CatalogExporter.vcxproj /p:Configuration=Release /p:Platform=x64 /nologo /verbosity:minimal
