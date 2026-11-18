# ============================================================
# ClassBeat 单日内存曲线：每分钟记录大屏相关进程的内存占用
# ------------------------------------------------------------
# 现场操作卡（docs/现场操作卡-教室验收-20261119.md）第四节用。
# 只读采样，不影响服务；Ctrl+C 停止，CSV 留在指定位置。
# 运行方式：
#   powershell -ExecutionPolicy Bypass -File .\mem-curve.ps1 ^
#       -OutputPath "E:\验收记录\内存曲线-20261119.csv"
# ============================================================

param(
  [string]$OutputPath = "$env:USERPROFILE\Desktop\内存曲线.csv",
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Continue'
Write-Output ("记录到：" + $OutputPath)
Write-Output ("每 " + $IntervalSeconds + " 秒采一次，Ctrl+C 停止。")
Write-Output ("开始时间：" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))

"时间,进程,内存MB" | Out-File $OutputPath -Encoding utf8

while ($true) {
  $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Get-Process | Where-Object { $_.ProcessName -match 'chrome|msedge|python' } |
    ForEach-Object {
      "$t,$($_.ProcessName),$([math]::Round($_.WorkingSet64/1MB,1))"
    } | Add-Content $OutputPath
  Start-Sleep -Seconds $IntervalSeconds
}
