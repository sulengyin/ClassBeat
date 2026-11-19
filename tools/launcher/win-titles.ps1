# 共享助手：枚举所有可见顶层窗口的标题（Win32 EnumWindows）。
# 被 watchdog.ps1 与 start-kiosk.ps1 各自点源（. .\win-titles.ps1）。
#
# 为什么不用 Get-Process 的 MainWindowTitle：一个浏览器进程只有一个
# 「主窗口」，老师用同一个浏览器开别的网页时，主窗口往往是老师正在看
# 的那一个，kiosk 窗口明明开着、标题却查不到——看门狗误判成「页面没了」，
# 每隔几秒重拉 kiosk，大屏不断跳出来抢屏（真机反馈 2026-11-19 ①）。
# 枚举全部窗口标题按内容找，谁在前台都找得到。

function Get-CBWinTitles {
  try {
    if (-not ('CBWinTitles' -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CBWinTitles {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int nMax);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  public static string[] VisibleTitles() {
    var list = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(512);
        if (GetWindowText(h, sb, 512) > 0) list.Add(sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@ -ErrorAction Stop
    }
    return ,@([CBWinTitles]::VisibleTitles())
  } catch {
    return $null
  }
}

function Test-CBWindowTitle([string]$Pattern) {
  $titles = Get-CBWinTitles
  if ($titles -eq $null) { return $null }   # 枚举不可用，调用方走旧判据
  foreach ($t in $titles) {
    if ($t -and $t -match $Pattern) { return $true }
  }
  return $false
}
