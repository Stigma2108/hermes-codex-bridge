$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HcPresence {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO value);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

  [DllImport("user32.dll")]
  public static extern bool SwitchDesktop(IntPtr desktop);

  [DllImport("user32.dll")]
  public static extern bool CloseDesktop(IntPtr desktop);
}
'@

$info = [HcPresence+LASTINPUTINFO]::new()
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
if (-not [HcPresence]::GetLastInputInfo([ref]$info)) { throw 'PRESENCE_LAST_INPUT' }

$tickNow = [BitConverter]::ToUInt32([BitConverter]::GetBytes([Environment]::TickCount), 0)
$idleMs = ([uint64]$tickNow + 0x100000000L - [uint64]$info.dwTime) % 0x100000000L
$desktop = [HcPresence]::OpenInputDesktop(0, $false, 0x0100)
try {
  $locked = $desktop -eq [IntPtr]::Zero -or -not [HcPresence]::SwitchDesktop($desktop)
} finally {
  if ($desktop -ne [IntPtr]::Zero) { [void][HcPresence]::CloseDesktop($desktop) }
}

[ordered]@{ locked = $locked; idleMs = $idleMs } | ConvertTo-Json -Compress
