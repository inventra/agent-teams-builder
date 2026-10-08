param([ValidateSet('Inspect','Enable','Restore')][string]$Mode='Inspect', [Parameter(Mandatory=$true)][string]$StatePath, [string]$ProcessName='MainMenu', [string]$WindowTitle='')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ErpWindowCompatibility {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h,int index);
 [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW",SetLastError=true)] static extern IntPtr SetLong(IntPtr h,int index,IntPtr value);
 [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
 public static long Find(int pid,string title) {var matches=new List<long>();EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id!=pid||!IsWindowVisible(h))return true;var s=new StringBuilder(256);GetClassName(h,s,256);var t=new StringBuilder(512);GetWindowText(h,t,512);if(title.Length>0 ? t.ToString()==title : s.ToString().StartsWith("DSC_Conductor_MainMenu",StringComparison.Ordinal))matches.Add(h.ToInt64());return true;},IntPtr.Zero);if(matches.Count!=1)throw new Exception("Expected one visible matching ERP window; found "+matches.Count);return matches[0];}
 public static long Style(long h) {return GetLong(new IntPtr(h),-20).ToInt64();}
 public static void WriteStyle(long h,long value) {SetLastError(0);var previous=SetLong(new IntPtr(h),-20,new IntPtr(value));int error=Marshal.GetLastWin32Error();if(previous==IntPtr.Zero&&error!=0)throw new Exception("SetWindowLongPtr failed: "+error);if(Style(h)!=value)throw new Exception("Style verification failed");}
}
'@
if($ProcessName -notin @('MainMenu','LeaderWorkCenter')){throw 'Only ERP processes are supported.'}
$erpProcesses=@(Get-Process -Name $ProcessName)
if($erpProcesses.Count -ne 1){throw 'Expected exactly one ERP process.'}
$erpProcess=$erpProcesses[0]
$erpHandle=[ErpWindowCompatibility]::Find($erpProcess.Id,$WindowTitle)
$currentStyle=[ErpWindowCompatibility]::Style($erpHandle)
$identity=[ordered]@{Pid=$erpProcess.Id;Started=$erpProcess.StartTime.ToUniversalTime().ToString('o');Handle=$erpHandle;OriginalStyle=$currentStyle}
if($Mode -eq 'Enable'){
 if(Test-Path -LiteralPath $StatePath){throw 'Backup already exists; inspect or restore it first.'}
 $identity|ConvertTo-Json|Set-Content -LiteralPath $StatePath -Encoding UTF8
 [ErpWindowCompatibility]::WriteStyle($erpHandle,($currentStyle -bor 0x40000))
}elseif($Mode -eq 'Restore'){
 $saved=Get-Content -LiteralPath $StatePath -Raw|ConvertFrom-Json
 if($saved.Pid -ne $identity.Pid -or $saved.Started -ne $identity.Started -or $saved.Handle -ne $erpHandle){throw 'ERP window identity changed; refusing stale restore.'}
 [ErpWindowCompatibility]::WriteStyle($erpHandle,[long]$saved.OriginalStyle)
}
[pscustomobject]@{Mode=$Mode;Pid=$erpProcess.Id;Handle=$erpHandle;Before=('0x{0:X}' -f $currentStyle);After=('0x{0:X}' -f [ErpWindowCompatibility]::Style($erpHandle))}|ConvertTo-Json
