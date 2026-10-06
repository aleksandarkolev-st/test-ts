$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Copilot synthetic capture background'
$form.FormBorderStyle='None'
$form.StartPosition='Manual'
$form.Bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.BackColor=[System.Drawing.Color]::FromArgb(21,180,85)
$form.ShowInTaskbar=$false
$label=New-Object System.Windows.Forms.Label
$label.Text='SYNTHETIC CAPTURE TEST - NO MEETING DATA'
$label.ForeColor=[System.Drawing.Color]::White
$label.Font=New-Object System.Drawing.Font('Segoe UI',26)
$label.AutoSize=$true
$label.Location=New-Object System.Drawing.Point(70,70)
$form.Controls.Add($label)
[System.Windows.Forms.Application]::Run($form)
