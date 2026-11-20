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
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr procId);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  private static IntPtr[] Hwnds = new IntPtr[0];
  private static string[] Titles = new string[0];
  private static void Collect() {
    var hs = new List<IntPtr>();
    var ts = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(512);
        if (GetWindowText(h, sb, 512) > 0) { hs.Add(h); ts.Add(sb.ToString()); }
      }
      return true;
    }, IntPtr.Zero);
    Hwnds = hs.ToArray();
    Titles = ts.ToArray();
  }
  public static string[] VisibleTitles() {
    Collect();
    return Titles;
  }
  private static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }
  // 找到第一个标题含 pattern 的可见窗口并带到前台；返回真实结果
  // （GetForegroundWindow 已切过去才算成功），找不到返回 false。
  public static bool ActivateByTitle(string pattern) {
    Collect();
    for (int i = 0; i < Titles.Length; i++) {
      if (Titles[i] != null && Titles[i].Contains(pattern)) {
        IntPtr h = Hwnds[i];
        if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE：最小化的先还原
        if (IsForeground(h)) return true;
        // 第一招：Alt 解锁前台锁的经典绕法
        keybd_event(0x12, 0, 0, UIntPtr.Zero);      // Alt down
        keybd_event(0x12, 0, 2, UIntPtr.Zero);      // Alt up (KEYEVENTF_KEYUP)
        SetForegroundWindow(h);
        BringWindowToTop(h);
        if (IsForeground(h)) return true;
        // 第二招：借前台线程的输入队列。PPT 放映 / 希沃白板全屏占着前台时，
        // 后台进程直接 SetForegroundWindow 多半被前台锁拒掉
        // （真机反馈 2026-11-20：课间/眼保健操没跳出来）；把自己挂进
        // 前台线程的输入队列后再调，系统就认了。
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, IntPtr.Zero) : 0;
        uint myThread = GetCurrentThreadId();
        if (fgThread != 0 && fgThread != myThread) {
          bool attached = AttachThreadInput(fgThread, myThread, true);
          BringWindowToTop(h);
          SetForegroundWindow(h);
          if (attached) AttachThreadInput(fgThread, myThread, false);
          if (IsForeground(h)) return true;
        }
        // 第三招：SwitchToThisWindow（系统内部切换，全屏应用占前台时多半能成）
        SwitchToThisWindow(h, true);
        if (IsForeground(h)) return true;
        // 第四招：把挡在前面的窗口最小化，再置前一次。节律时刻把大屏带
        // 回来本来就是提醒的目的，投影被收起是预期行为。
        fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && fg != h) {
          ShowWindow(fg, 6);   // SW_MINIMIZE
          SetForegroundWindow(h);
        }
        return IsForeground(h);
      }
    }
    return false;
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

function Show-CBWindowByTitle {
  # 节律时刻（课间 / 眼保健操开始）把已在的大屏窗口带到前台。
  # SetForegroundWindow 有前台锁：后台进程直接调会被 Windows 拒掉——
  # PPT 放映、希沃白板全屏时几乎必拒（真机反馈 2026-11-20：课间/眼保健操
  # 没跳出来）。升级链：Alt 绕锁 → AttachThreadInput 借前台线程 →
  # SwitchToThisWindow → 最小化挡路窗。返回真实结果（前台真的切过去
  # 才算成功）；调用方对失败会在本时段内重试几次。
  param([string]$Pattern = '班级节律屏')
  try {
    if (-not ('CBWinTitles' -as [type])) { $null = Get-CBWinTitles }
    if (-not ('CBWinTitles' -as [type])) { return $false }
    return [CBWinTitles]::ActivateByTitle($Pattern)
  } catch {
    return $false
  }
}
