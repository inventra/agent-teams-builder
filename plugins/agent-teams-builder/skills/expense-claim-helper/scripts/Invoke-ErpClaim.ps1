param(
    [ValidateSet('inspect','query','snapshot','probe-grid','validate','create','dialogs','review')][string]$Command='inspect',
    [string]$Company,[string]$RequestFile,[string]$Number,[string]$DocumentType='I502',
    [string]$OutputPath,[string]$JournalDirectory=(Join-Path (Get-Location) 'erp-runs'),
    [switch]$Save,[switch]$ReviewAtEnd,[string]$PythonPath
)
$ErrorActionPreference='Stop'
if (-not $PythonPath) {
    $erpBundledPython=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $erpBundledPython) { $PythonPath=$erpBundledPython }
    else {
        $erpPythonCommand=Get-Command python.exe -ErrorAction SilentlyContinue
        if ($erpPythonCommand -and $erpPythonCommand.Source -notlike '*\WindowsApps\*') { $PythonPath=$erpPythonCommand.Source }
    }
}
if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath)) { throw 'Python 3 not found. Pass -PythonPath with the python.exe path. Grid OCR also requires Pillow.' }
$erpArguments=@('-X','utf8',(Join-Path $PSScriptRoot 'erp_native.py'),$Command,'--journal-dir',$JournalDirectory)
if ($Company) { $erpArguments+=@('--company',$Company) }
if ($RequestFile) { $erpArguments+=@('--request',$RequestFile) }
if ($Number) { $erpArguments+=@('--number',$Number,'--document-type',$DocumentType) }
if ($OutputPath) { $erpArguments+=@('--out',$OutputPath) }
if ($Save) { $erpArguments+='--save' }
if ($ReviewAtEnd) { $erpArguments+='--review-at-end' }
& $PythonPath @erpArguments
exit $LASTEXITCODE
