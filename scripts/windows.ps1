param([string]$Title='微信')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class WmpfWindows {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
}
'@
$script:taskWindows=@()
[WmpfWindows]::EnumWindows({param($h,$l)
 $taskName=New-Object Text.StringBuilder 512
 [void][WmpfWindows]::GetWindowText($h,$taskName,512)
 if($taskName.ToString() -ceq $Title -and [WmpfWindows]::IsWindowVisible($h)){
  $taskRect=New-Object WmpfWindows+RECT
  [void][WmpfWindows]::GetWindowRect($h,[ref]$taskRect)
  [uint32]$taskProcessId=0
  [void][WmpfWindows]::GetWindowThreadProcessId($h,[ref]$taskProcessId)
  $taskProcess=Get-Process -Id $taskProcessId -ErrorAction SilentlyContinue
  $script:taskWindows+=@{title=$Title;hwnd=$h.ToInt64();pid=$taskProcessId;process=$taskProcess.ProcessName;version=$taskProcess.FileVersion;dpi=[WmpfWindows]::GetDpiForWindow($h);left=$taskRect.Left;top=$taskRect.Top;right=$taskRect.Right;bottom=$taskRect.Bottom}
 }
 return $true
},[IntPtr]::Zero)|Out-Null
ConvertTo-Json -InputObject @($taskWindows) -Compress -Depth 4
