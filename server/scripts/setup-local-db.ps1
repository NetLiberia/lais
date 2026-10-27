# Sets up LAIS on a local PostgreSQL + PostGIS server (Windows).
# Run it yourself in a terminal; it asks for passwords, so they never appear in a file you share or in chat:
#
#   powershell -ExecutionPolicy Bypass -File server\scripts\setup-local-db.ps1
#
# It creates the lais_owner login, the lais and lais_test databases with PostGIS, and writes server\.env.
# Safe to re-run: existing roles and databases are kept, and an existing .env is never overwritten.

param(
  [string]$PgBin = 'C:\Program Files\PostgreSQL\18\bin',
  [string]$HostName = 'localhost',
  [int]$Port = 5432
)

$ErrorActionPreference = 'Stop'
$serverDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $serverDir '.env'
$psql = Join-Path $PgBin 'psql.exe'

if (-not (Test-Path $psql)) { throw "psql.exe not found in $PgBin. Pass -PgBin with your PostgreSQL bin folder." }
if (Test-Path $envFile) { throw "$envFile already exists. Remove or rename it first if you want this script to write a new one." }

function Read-Secret([string]$prompt) {
  $secure = Read-Host -AsSecureString $prompt
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# SQL string literal: double any single quotes.
function Sql-Literal([string]$value) { return "'" + $value.Replace("'", "''") + "'" }

# Runs SQL as the postgres superuser, piped through stdin so no password or SQL is left in a file.
function Invoke-Psql([string]$database, [string]$sql) {
  $output = $sql | & $psql -X -q -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U postgres -d $database -f - 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql failed on database '$database': $output" }
  return $output
}

Write-Host 'LAIS local database setup' -ForegroundColor Cyan
$env:PGPASSWORD = Read-Secret "Password of the PostgreSQL 'postgres' superuser"
try {
  Invoke-Psql 'postgres' 'SELECT 1;' | Out-Null
  Write-Host 'Connected as postgres.'

  $ownerPassword = Read-Secret "Choose a password for the new 'lais_owner' login (12+ characters)"
  if ($ownerPassword.Length -lt 12) { throw 'The lais_owner password must be at least 12 characters.' }
  if ($ownerPassword -ne (Read-Secret 'Type it again')) { throw 'The passwords did not match.' }

  $seedPassword = Read-Host 'Password for the synthetic demo accounts [press Enter for demo-password-2026]'
  if ([string]::IsNullOrWhiteSpace($seedPassword)) { $seedPassword = 'demo-password-2026' }
  if ($seedPassword.Length -lt 12) { throw 'The demo account password must be at least 12 characters.' }

  # Login role: created, or its password updated if it already exists.
  Invoke-Psql 'postgres' @"
DO `$`$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lais_owner') THEN
    ALTER ROLE lais_owner LOGIN PASSWORD $(Sql-Literal $ownerPassword);
  ELSE
    CREATE ROLE lais_owner LOGIN PASSWORD $(Sql-Literal $ownerPassword);
  END IF;
END
`$`$;
"@ | Out-Null
  Write-Host 'Login lais_owner is ready.'

  foreach ($db in @('lais', 'lais_test')) {
    $exists = Invoke-Psql 'postgres' "SELECT 1 FROM pg_database WHERE datname = '$db';"
    if (-not ($exists -match '1')) {
      Invoke-Psql 'postgres' "CREATE DATABASE $db OWNER lais_owner ENCODING 'UTF8';" | Out-Null
      Write-Host "Created database $db."
    } else {
      Write-Host "Database $db already exists; kept."
    }
    # PostGIS is created by the superuser so the application login needs no superuser rights.
    Invoke-Psql $db 'CREATE EXTENSION IF NOT EXISTS postgis;' | Out-Null
    $version = (Invoke-Psql $db 'SELECT postgis_lib_version();' | Out-String).Trim()
    Write-Host "PostGIS $version enabled in $db."
  }
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

$encoded = [Uri]::EscapeDataString($ownerPassword)
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$mfaKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })

$content = (Get-Content (Join-Path $serverDir '.env.example') -Raw)
$content = $content -replace '(?m)^DATABASE_URL=.*$', "DATABASE_URL=postgres://lais_owner:$encoded@${HostName}:$Port/lais"
$content = $content -replace '(?m)^TEST_DATABASE_URL=.*$', "TEST_DATABASE_URL=postgres://lais_owner:$encoded@${HostName}:$Port/lais_test"
$content = $content -replace '(?m)^MFA_ENCRYPTION_KEY=.*$', "MFA_ENCRYPTION_KEY=$mfaKey"
$content = $content -replace '(?m)^SEED_PASSWORD=.*$', "SEED_PASSWORD=$seedPassword"
# UTF-8 without BOM, so dotenv reads the first line correctly.
[IO.File]::WriteAllText($envFile, $content, (New-Object Text.UTF8Encoding $false))

Write-Host ''
Write-Host "Wrote $envFile (it is git-ignored; keep it private)." -ForegroundColor Green
Write-Host 'Next: npm run db:migrate, npm run db:seed, then npm run dev:server and npm run dev:web.'
