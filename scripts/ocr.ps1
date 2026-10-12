param([Parameter(Mandatory=$true)][string]$Image)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
$taskAsTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1})[0]
function Await-WinRt($Operation,[Type]$ResultType) {
 $taskAsync=$taskAsTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
 if(-not $taskAsync.Wait(15000)){throw 'OCR timed out'}
 return $taskAsync.Result
}
$taskFile=Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
$taskStream=Await-WinRt ($taskFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
 $taskDecoder=Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($taskStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 $taskBitmap=Await-WinRt ($taskDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 try {
  $taskEngine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if(-not $taskEngine){throw 'Windows OCR language pack missing'}
  $taskResult=Await-WinRt ($taskEngine.RecognizeAsync($taskBitmap)) ([Windows.Media.Ocr.OcrResult])
  $taskLines=@(foreach($taskLine in $taskResult.Lines){
   $taskWords=@(foreach($taskWord in $taskLine.Words){$taskR=$taskWord.BoundingRect;@{text=$taskWord.Text;x=$taskR.X;y=$taskR.Y;width=$taskR.Width;height=$taskR.Height}})
   @{text=$taskLine.Text;words=$taskWords}
  })
  @{width=$taskDecoder.PixelWidth;height=$taskDecoder.PixelHeight;lines=$taskLines} | ConvertTo-Json -Depth 6 -Compress
 } finally {$taskBitmap.Dispose()}
} finally {$taskStream.Dispose()}
