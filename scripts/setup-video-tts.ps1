param(
  [string]$Python = "python",
  [string]$VenvPath = ".venv-video"
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

& $Python -m venv --clear $VenvPath
Assert-LastExitCode "venv creation"
$venvPython = Join-Path $VenvPath "Scripts\python.exe"

& $venvPython -m pip install --upgrade pip
Assert-LastExitCode "pip upgrade"

# pyopenjtalk 0.4.1 has no Windows wheel. pyopenjtalk-plus is its drop-in
# replacement (same import name) and ships pinned CPython/Windows wheels.
& $venvPython -m pip install "kokoro==0.9.4" soundfile
Assert-LastExitCode "Kokoro installation"
& $venvPython -m pip install --no-deps "misaki[ja]==0.9.4"
Assert-LastExitCode "Misaki Japanese extra selection"
& $venvPython -m pip install --only-binary=:all: "pyopenjtalk-plus==0.4.1.post8"
Assert-LastExitCode "OpenJTalk wheel installation"
& $venvPython -m pip install fugashi jaconv mojimoji unidic
Assert-LastExitCode "Japanese G2P dependencies"

& $venvPython -m unidic download
Assert-LastExitCode "UniDic download"
& $venvPython -c "from kokoro import KPipeline; from misaki import ja; import pyopenjtalk, unidic; print('Japanese TTS imports OK')"
Assert-LastExitCode "Japanese TTS import smoke"

Write-Host ""
Write-Host "Kokoro + Misaki Japanese TTS runtime is ready."
Write-Host "Set VIDEO_TTS_PYTHON=$((Resolve-Path $venvPython).Path) in .env."
Write-Host "HyperFrames remains the renderer; its built-in TTS is not used."
