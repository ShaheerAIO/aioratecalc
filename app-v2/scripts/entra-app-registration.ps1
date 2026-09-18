#Requires -Modules Microsoft.Graph.Authentication
<#
  Creates (or updates) the Entra app registration EasyOB uses for staff sign-in,
  and writes the resulting values into app-v2/.env.local.

  Run:  pwsh -NoProfile -File scripts/entra-app-registration.ps1

  Idempotent: re-running reuses the existing registration by displayName, refreshes
  its redirect URIs / optional claims, and mints a NEW client secret. That makes this
  the secret-rotation path too (the current secret expires 2028-09-17) — after running
  it, push the new secret to the Vercel project as well:

      npx vercel env rm AUTH_MICROSOFT_ENTRA_ID_SECRET production
      npx vercel env add AUTH_MICROSOFT_ENTRA_ID_SECRET production

  Requires Global Admin or Cloud Application Administrator. The first run consents
  "Microsoft Graph Command Line Tools" for Application.ReadWrite.All.

  The secret is written to .env.local and never printed. Pass -OutJson <path> to also
  drop a raw JSON copy for piping into `vercel env add` — deliberately OFF by default
  so a plaintext secret can't land in the repo. Put it under /tmp if you use it.
#>
param(
  [string]   $DisplayName   = 'EasyOB Staff Sign-In',
  [string[]] $RedirectUris  = @(
    'http://localhost:5001/api/auth/callback/microsoft-entra-id',
    'https://aioeasyob.vercel.app/api/auth/callback/microsoft-entra-id'
  ),
  [int]      $SecretMonths  = 24,
  [string]   $EnvFile       = "$PSScriptRoot/../.env.local",
  [string]   $OutJson       = ''
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'
$WANTED_SCOPES = @('openid', 'profile', 'email')

function Graph {
  param($Method, $Uri, $Body)
  if ($Body) {
    Invoke-MgGraphRequest -Method $Method -Uri $Uri -Body ($Body | ConvertTo-Json -Depth 12) `
      -ContentType 'application/json' -OutputType PSObject
  } else {
    Invoke-MgGraphRequest -Method $Method -Uri $Uri -OutputType PSObject
  }
}

Import-Module Microsoft.Graph.Authentication

# ---- 1. sign in -------------------------------------------------------------
if (-not (Get-MgContext)) {
  Write-Host '==> Signing in to Microsoft Graph (a browser window will open)...'
  Connect-MgGraph -NoWelcome -Scopes @(
    'Application.ReadWrite.All'                # create the app registration + secret
    'DelegatedPermissionGrant.ReadWrite.All'   # pre-consent openid/profile/email (best effort)
  )
}
$ctx = Get-MgContext
if (-not $ctx) { throw 'Not connected to Microsoft Graph.' }
$tenantId = $ctx.TenantId
Write-Host "==> Tenant : $tenantId"
Write-Host "==> Account: $($ctx.Account)"

# ---- 2. resolve the Graph delegated-permission ids by NAME ------------------
# Looked up rather than hardcoded: a wrong GUID here silently produces a
# confusing consent screen instead of an error.
$graphSp = Graph GET "v1.0/servicePrincipals(appId='$GRAPH_APP_ID')?`$select=id,oauth2PermissionScopes"
$scopes  = @($graphSp.oauth2PermissionScopes | Where-Object { $WANTED_SCOPES -contains $_.value })
if ($scopes.Count -ne $WANTED_SCOPES.Count) {
  throw "Expected $($WANTED_SCOPES.Count) Graph scopes, resolved $($scopes.Count)."
}
$resourceAccess = @($scopes | ForEach-Object { @{ id = $_.id; type = 'Scope' } })
Write-Host "==> Scopes : $($scopes.value -join ', ')"

# ---- 3. create or update the application -----------------------------------
$appBody = @{
  signInAudience = 'AzureADMyOrg'   # single tenant; belt to the tid check's braces
  web            = @{
    redirectUris          = $RedirectUris
    implicitGrantSettings = @{ enableIdTokenIssuance = $false; enableAccessTokenIssuance = $false }
  }
  # `email` is only emitted when the user has a mail attribute, so ask for it
  # explicitly; `upn` is the fallback readEntraIdentity() relies on.
  optionalClaims = @{
    idToken     = @(
      @{ name = 'email'; essential = $false; additionalProperties = @() }
      @{ name = 'upn';   essential = $false; additionalProperties = @() }
    )
    accessToken = @()
    saml2Token  = @()
  }
  requiredResourceAccess = @(
    @{ resourceAppId = $GRAPH_APP_ID; resourceAccess = $resourceAccess }
  )
}

$escaped  = $DisplayName.Replace("'", "''")
$existing = @((Graph GET "v1.0/applications?`$filter=displayName eq '$escaped'").value)

if ($existing.Count -gt 1) {
  throw "$($existing.Count) app registrations already named '$DisplayName'. Resolve by hand."
} elseif ($existing.Count -eq 1) {
  $app = $existing[0]
  Write-Host "==> Reusing existing registration $($app.appId)"
  Graph PATCH "v1.0/applications/$($app.id)" $appBody | Out-Null
} else {
  $app = Graph POST 'v1.0/applications' ($appBody + @{ displayName = $DisplayName })
  Write-Host "==> Created registration $($app.appId)"
}

# ---- 4. service principal ---------------------------------------------------
# Graph does NOT create this automatically (the portal does). Without it,
# sign-in fails with "application not found in the directory".
$sp = @((Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'").value)[0]
if (-not $sp) {
  $sp = Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId }
  Write-Host "==> Created service principal $($sp.id)"
} else {
  Write-Host "==> Service principal already present ($($sp.id))"
}

# ---- 5. tenant-wide consent for the three sign-in scopes (best effort) ------
# Saves every staff member an individual consent prompt. Not fatal if refused.
try {
  $grants = @((Graph GET "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)'").value)
  $mine   = $grants | Where-Object { $_.resourceId -eq $graphSp.id -and $_.consentType -eq 'AllPrincipals' }
  $body   = @{
    clientId    = $sp.id
    consentType = 'AllPrincipals'
    resourceId  = $graphSp.id
    scope       = ($WANTED_SCOPES -join ' ')
  }
  if ($mine) {
    Graph PATCH "v1.0/oauth2PermissionGrants/$($mine[0].id)" @{ scope = $body.scope } | Out-Null
  } else {
    Graph POST 'v1.0/oauth2PermissionGrants' $body | Out-Null
  }
  Write-Host '==> Granted tenant-wide consent for openid/profile/email'
} catch {
  Write-Warning "Could not pre-consent (staff will see a one-time consent prompt): $($_.Exception.Message)"
}

# ---- 6. client secret -------------------------------------------------------
$pw = Graph POST "v1.0/applications/$($app.id)/addPassword" @{
  passwordCredential = @{
    displayName = "easyob-$(Get-Date -Format yyyyMMdd)"
    endDateTime = (Get-Date).AddMonths($SecretMonths).ToUniversalTime().ToString('o')
  }
}
if (-not $pw.secretText) { throw 'Graph returned no secretText.' }
Write-Host "==> Minted client secret, expires $($pw.endDateTime)"

# ---- 7. write .env.local ----------------------------------------------------
$issuer = "https://login.microsoftonline.com/$tenantId/v2.0"
$vars = [ordered]@{
  AUTH_MICROSOFT_ENTRA_ID_ID     = $app.appId
  AUTH_MICROSOFT_ENTRA_ID_SECRET = $pw.secretText
  AUTH_MICROSOFT_ENTRA_ID_ISSUER = $issuer
}

if (Test-Path $EnvFile) {
  $backup = "$EnvFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $EnvFile $backup
  Write-Host "==> Backed up .env.local -> $(Split-Path -Leaf $backup)"
  $lines = @(Get-Content -LiteralPath $EnvFile)
} else {
  $lines = @()
}

foreach ($k in $vars.Keys) {
  # @next/env runs dotenv-expand, so a raw `$` in a secret is eaten as a
  # variable reference. Backslash-escaping is the only thing that stops it.
  # NB: Vercel is the opposite — paste the RAW value there.
  $v = $vars[$k].Replace('$', '\$')
  $line = "$k=$v"
  $idx = [Array]::FindIndex($lines, [Predicate[string]] { param($l) $l -match "^\s*$k\s*=" })
  if ($idx -ge 0) { $lines[$idx] = $line } else { $lines += $line }
}
Set-Content -LiteralPath $EnvFile -Value $lines
Write-Host "==> Wrote $($vars.Keys -join ', ') to .env.local"

# ---- 8. optional raw copy, for piping into `vercel env add` -----------------
if ($OutJson) {
  ($vars | ConvertTo-Json) | Set-Content -LiteralPath $OutJson
  if ($IsLinux -or $IsMacOS) { chmod 600 $OutJson }
  Write-Warning "Raw secret written to $OutJson - delete it once pushed to Vercel."
}

Write-Host ''
Write-Host '=============================================='
Write-Host "client id : $($app.appId)"
Write-Host "tenant id : $tenantId"
Write-Host "issuer    : $issuer"
Write-Host "secret    : $($pw.secretText.Substring(0,4))... (len $($pw.secretText.Length)) - in .env.local, not printed"
Write-Host "redirects :"
$RedirectUris | ForEach-Object { Write-Host "            $_" }
Write-Host '=============================================='
Write-Host ''
Write-Host 'Entra allows no wildcard redirect URIs and Auth.js derives redirect_uri from'
Write-Host 'the request Host, so ONLY the URIs above can complete a sign-in. Preview'
Write-Host 'deployments must use /login/breakglass. A custom domain needs its URI added here.'
