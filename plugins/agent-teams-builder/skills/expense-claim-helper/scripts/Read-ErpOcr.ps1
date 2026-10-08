param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$erpAsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-ErpAsync($Operation, [Type]$ResultType) {
    $task = $erpAsTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
    if (-not $task.Wait(15000)) { throw 'Windows OCR operation timed out' }
    $task.Result
}
$erpFile=Wait-ErpAsync ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($ImagePath))) ([Windows.Storage.StorageFile])
$erpStream=Wait-ErpAsync ($erpFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
    $erpDecoder=Wait-ErpAsync ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($erpStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $erpBitmap=Wait-ErpAsync ($erpDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
        $erpEngine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -eq $erpEngine) { throw 'No local Windows OCR language is installed' }
        $erpResult=Wait-ErpAsync ($erpEngine.RecognizeAsync($erpBitmap)) ([Windows.Media.Ocr.OcrResult])
        $erpLines=@(foreach($erpLine in $erpResult.Lines) {
            [pscustomobject]@{text=$erpLine.Text;words=@(foreach($erpWord in $erpLine.Words) {
                $r=$erpWord.BoundingRect
                [pscustomobject]@{text=$erpWord.Text;x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}
            })}
        })
        [pscustomobject]@{language=$erpEngine.RecognizerLanguage.LanguageTag;lines=$erpLines} | ConvertTo-Json -Depth 6 -Compress
    } finally { if ($erpBitmap) { $erpBitmap.Dispose() } }
} finally { $erpStream.Dispose() }
