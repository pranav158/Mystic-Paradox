@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Installer vswhere.exe was not found.
  exit /b 3
)
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe`) do set "MSBUILD=%%I"
if not defined MSBUILD (
  echo MSBuild with C++ tools was not found.
  exit /b 3
)
"%MSBUILD%" "%~dp0CatalogExporter.vcxproj" /p:Configuration=Release /p:Platform=x64 /nologo /verbosity:minimal
exit /b %errorlevel%