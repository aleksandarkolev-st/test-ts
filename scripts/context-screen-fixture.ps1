param([Parameter(Mandatory=$true)][string]$StopFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CopilotFixturePointer { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }'
$copilotScreen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$copilotForm=New-Object System.Windows.Forms.Form
$copilotForm.FormBorderStyle='None'
$copilotForm.StartPosition='Manual'
$copilotForm.Bounds=$copilotScreen
$copilotForm.TopMost=$true
$copilotForm.BackColor=[System.Drawing.Color]::FromArgb(248,245,239)
$copilotForm.Text='Synthetic Copilot screen verification'
function Add-FixtureLabel([string]$Text,[int]$X,[int]$Y,[int]$Width,[int]$Height,[int]$Size,[string]$Background,[string]$Foreground) {
    $copilotLabel=New-Object System.Windows.Forms.Label
    $copilotLabel.Text=$Text
    $copilotLabel.Location=New-Object System.Drawing.Point($X,$Y)
    $copilotLabel.Size=New-Object System.Drawing.Size($Width,$Height)
    $copilotLabel.Font=New-Object System.Drawing.Font('Arial',$Size)
    $copilotLabel.TextAlign='MiddleCenter'
    $copilotLabel.BackColor=[System.Drawing.ColorTranslator]::FromHtml($Background)
    $copilotLabel.ForeColor=[System.Drawing.ColorTranslator]::FromHtml($Foreground)
    $copilotForm.Controls.Add($copilotLabel)
}
Add-FixtureLabel 'SYNTHETIC SCREEN TEST' 80 60 1200 130 44 '#f8f5ef' '#151515'
Add-FixtureLabel 'Visual verification code: ORBIT-649' 80 220 1200 120 34 '#f8f5ef' '#151515'
Add-FixtureLabel 'QUEUE A' 150 420 440 220 34 '#6247a8' '#ffffff'
Add-FixtureLabel '->' 610 420 140 220 40 '#f8f5ef' '#151515'
Add-FixtureLabel 'ARCHIVE B' 770 420 440 220 34 '#23846f' '#ffffff'
$copilotTimer=New-Object System.Windows.Forms.Timer
$copilotTimer.Interval=100
$copilotTimer.Add_Tick({if(Test-Path -LiteralPath $StopFile){$copilotForm.Close()}})
$copilotForm.Add_Shown({
    $copilotForm.Activate()
    [CopilotFixturePointer]::SetCursorPos($copilotScreen.X+300,$copilotScreen.Y+250) | Out-Null
    $copilotTimer.Start()
    [Console]::WriteLine('{"event":"ready"}')
    [Console]::Out.Flush()
})
try {[System.Windows.Forms.Application]::Run($copilotForm)} finally {$copilotTimer.Dispose();$copilotForm.Dispose()}
