# A real left click at a screen point (physical px): moves the pointer there and clicks, like a person would.
# Used only on Buddy's own test windows, with the user's permission. real-click.ps1 <x> <y>
param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
[void][M]::SetProcessDPIAware()
[void][M]::SetCursorPos($X, $Y)
Start-Sleep -Milliseconds 250
[M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) # left down
Start-Sleep -Milliseconds 70
[M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # left up
