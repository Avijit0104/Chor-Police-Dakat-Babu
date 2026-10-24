# Draws the CPDB app icons (four role tiles: C P D B) into public/.
# Run with: powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$out = (Resolve-Path (Join-Path $PSScriptRoot '..\public')).Path
$tiles = @(
  @{ Letter = 'C'; Color = '#a07cff' },
  @{ Letter = 'P'; Color = '#4f8cff' },
  @{ Letter = 'D'; Color = '#ff5c63' },
  @{ Letter = 'B'; Color = '#f6b93b' }
)

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# $pad is the empty margin around the tiles as a share of the size. Maskable icons
# need a bigger margin because Android crops them into circles and squircles.
function Save-Icon([int]$size, [double]$pad, [bool]$fullBleed, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $dark = [System.Drawing.ColorTranslator]::FromHtml('#13111c')
  $bg = New-Object System.Drawing.SolidBrush $dark
  if ($fullBleed) { $g.FillRectangle($bg, 0, 0, $size, $size) }
  else { $g.FillPath($bg, (New-RoundedRect 0 0 $size $size ($size * 0.22))) }

  $inner = $size * (1 - 2 * $pad)
  $gap = $inner * 0.07
  $tile = ($inner - $gap) / 2
  $font = New-Object System.Drawing.Font('Segoe UI', [single]($tile * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $ink = New-Object System.Drawing.SolidBrush $dark

  for ($i = 0; $i -lt 4; $i++) {
    $x = $size * $pad + ($i % 2) * ($tile + $gap)
    $y = $size * $pad + [math]::Floor($i / 2) * ($tile + $gap)
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($tiles[$i].Color))
    $g.FillPath($fill, (New-RoundedRect $x $y $tile $tile ($tile * 0.22)))
    $box = New-Object System.Drawing.RectangleF([single]$x, [single]($y + $tile * 0.03), [single]$tile, [single]$tile)
    $g.DrawString($tiles[$i].Letter, $font, $ink, $box, $fmt)
  }

  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

Save-Icon 192 0.14 $false 'icon-192.png'
Save-Icon 512 0.14 $false 'icon-512.png'
Save-Icon 512 0.22 $true 'icon-maskable-512.png'
Write-Output "Icons saved to $out"
