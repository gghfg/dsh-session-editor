<#
.SYNOPSIS
  启动 DSH 会话编辑器的图形界面。

.DESCRIPTION
  由 start.cmd 调用（cmd 会把控制台切到 UTF-8，所以这里可以安全输出中文）。
  先做几项环境检查，再把 server.mjs 跑起来。编辑会话日志前请先完全退出
  DeepSeek Harness。

.EXAMPLE
  .\start.cmd
  .\start.cmd --port=4320
#>
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Text) { Write-Host $Text }
function Write-Bad([string]$Text) { Write-Host $Text -ForegroundColor Red }

# 尽量让中文在这台机器上稳定输出（PowerShell 5.1 也走这段）。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Push-Location $PSScriptRoot
try {
  # 1) node 是否可用
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    Write-Bad '找不到 node。请先安装 Node.js 20 或更新版本，并确保它在 PATH 里。'
    Write-Host '下载地址：https://nodejs.org/'
    exit 1
  }

  # 2) 关键文件是否齐全
  $missing = @()
  foreach ($relative in @('server.mjs', 'tools\session-store.mjs', 'web\index.html')) {
    if (-not (Test-Path (Join-Path $PSScriptRoot $relative))) { $missing += $relative }
  }
  if ($missing.Count -gt 0) {
    Write-Bad ('缺少文件：' + ($missing -join '、'))
    Write-Host '请确认你是在完整的 dsh-session-editor 目录里运行这个脚本。'
    exit 1
  }

  # 3) 依赖（校验与测试用）。界面本身零依赖，缺了也能正常浏览和改写。
  if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\@deepseek-ai\dsh-session'))) {
    Write-Host '提示：还没安装可选的校验依赖，界面照常可用。' -ForegroundColor Yellow
    Write-Host '      想让 verify-log.mjs / npm test 可用，先在本目录执行一次：'
    Write-Host '          npm install'
    Write-Host ''
  }

  # 4) 提示 DSH 是否在运行 —— 在运行也允许启动，界面顶部会给出警告
  $dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($null -ne $dsh) {
    Write-Host '注意：DeepSeek Harness 正在运行。' -ForegroundColor Yellow
    Write-Host '      界面可以浏览，但改完再启动才会生效；建议先完全退出它再编辑。'
    Write-Host '      强烈建议：退出 DSH → 编辑 → 重启 DSH。'
    Write-Host ''
  }

  # 5) 组装参数并启动
  $nodeArgs = @('server.mjs')
  if ($null -ne $Rest -and $Rest.Count -gt 0) { $nodeArgs += $Rest }

  Write-Info '正在启动 DSH 会话编辑器…'
  Write-Host ''
  & $node.Source @nodeArgs
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }

  if ($code -ne 0) {
    Write-Host ''
    Write-Bad "编辑器退出，代码 $code。"
    Write-Host '若提示端口被占用，换一个端口再试：start.cmd --port=4320'
  }
  exit $code
}
finally {
  Pop-Location
}
