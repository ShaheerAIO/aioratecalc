#Requires -Modules Microsoft.Graph.Authentication
<#
  ⚠️ NOT THE LIVE SETUP. EasyOB sends mail through the EXISTING "AIO Document
  Send" registration (appId 747446ca-b3c9-4537-b2b5-066de0264e70 — the app
  behind "mockusign"), using a second client secret minted on it. See
  "Transactional email" in the root CLAUDE.md.

  This script creates a SEPARATE registration instead, and exists only as the
  escape hatch if a distinct mail identity is ever worth its cost. Read that
  cost before running it:

    - Creating the app + service principal + secret needs only Application
      Administrator.
    - GRANTING Mail.Send needs GLOBAL ADMINISTRATOR or PRIVILEGED ROLE
      ADMINISTRATOR. Application/Cloud Application Administrator is blocked by
      Microsoft, by design — an app admin who could grant application
      permissions could grant themselves Directory.ReadWrite.All. Verified
      live 2026-09-24: 403 Authorization_RequestDenied.
    - The Exchange fence needs Exchange Administrator, separately.

  Reusing AIO Document Send costs none of those: Mail.Send is already granted
  and it is already fenced to aiodocuments@aioapp.com. What you buy by running
  this instead is cleaner audit attribution — two products currently share one
  identity in sign-in and audit logs — and insulation from someone deleting
  that app for mockusign's reasons. Rights live on the app registration, not
  on the secret, so a second secret already gives INDEPENDENT ROTATION; it does
  not give independent permissions.

  Run:  pwsh -NoProfile -File scripts/entra-mail-app.ps1

  Idempotent: re-running reuses the registration by displayName and mints a NEW
  secret, so it is also the rotation path. Consent failure is non-fatal — the
  secret and .env.local write still happen, and the summary says what is
  outstanding. The secret is written to .env.local and never printed.

  Afterwards, push to Vercel with the RAW `$`, not the `\$`-escaped form that
  goes in .env.local — Vercel stores literally and does not run dotenv-expand:

      npx vercel env rm MAIL_GRAPH_CLIENT_SECRET production
      npx vercel env add MAIL_GRAPH_CLIENT_SECRET production
#>
param(
  [string] $DisplayName   = 'EasyOB Mail',
  # The mailbox mail is sent AS. Must be a real mailbox, not an alias — Graph's
  # sendMail is addressed to /users/{this}. aiodocuments@aioapp.com is the
  # shared mailbox `AIO Document Send` already uses.
  [string] $SenderAddress = 'aiodocuments@aioapp.com',
  # The mail-enabled security group that fences which mailboxes this app may
  # send as. Reusing the existing one means the fence already contains the
  # sender and needs no new membership.
  [string] $ScopeGroup    = 'AIO App Senders',
  [string] $FromName      = 'AIO Payments',
  [int]    $SecretMonths  = 24,
  [string] $EnvFile       = "$PSScriptRoot/../.env.local"
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'

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
    'Application.ReadWrite.All'   # create the app registration + secret
    'AppRoleAssignment.ReadWrite.All'  # admin-consent Mail.Send
  )
}
$ctx = Get-MgContext
if (-not $ctx) { throw 'Not connected to Microsoft Graph.' }
$tenantId = $ctx.TenantId
Write-Host "==> Tenant : $tenantId"
Write-Host "==> Account: $($ctx.Account)"
Write-Host "==> Sender : $SenderAddress"

# ---- 2. resolve the Mail.Send APPLICATION role id by name -------------------
# Looked up rather than hardcoded, for the same reason the sign-in script looks
# up its delegated scopes: a wrong GUID here fails confusingly rather than loudly.
$graphSp   = Graph GET "v1.0/servicePrincipals(appId='$GRAPH_APP_ID')?`$select=id,appRoles"
$mailSend  = $graphSp.appRoles | Where-Object { $_.value -eq 'Mail.Send' -and $_.allowedMemberTypes -contains 'Application' }
if (-not $mailSend) { throw 'Could not resolve the Mail.Send application role on Microsoft Graph.' }
Write-Host "==> Role   : Mail.Send ($($mailSend.id))"

# ---- 3. create or update the application ------------------------------------
$appBody = @{
  signInAudience         = 'AzureADMyOrg'   # single tenant
  requiredResourceAccess = @(@{
    resourceAppId  = $GRAPH_APP_ID
    resourceAccess = @(@{ id = $mailSend.id; type = 'Role' })   # Role = application permission
  })
}

$escaped  = $DisplayName.Replace("'", "''")
$existing = (Graph GET "v1.0/applications?`$filter=displayName eq '$escaped'&`$select=id,appId").value | Select-Object -First 1

if ($existing) {
  Write-Host "==> Updating existing registration ($($existing.appId))"
  Graph PATCH "v1.0/applications/$($existing.id)" $appBody | Out-Null
  $app = Graph GET "v1.0/applications/$($existing.id)?`$select=id,appId"
} else {
  Write-Host '==> Creating new registration'
  $app = Graph POST 'v1.0/applications' ($appBody + @{ displayName = $DisplayName })
}
Write-Host "==> appId  : $($app.appId)"

# ---- 4. the service principal ----------------------------------------------
# A registration created through Graph rather than the portal does NOT get one
# implicitly, and without it sign-in fails with "application not found in the
# directory". Same trap the staff sign-in script documents.
$sp = (Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id").value | Select-Object -First 1
if (-not $sp) {
  Write-Host '==> Creating service principal'
  $sp = Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId }
}
Write-Host "==> spId   : $($sp.id)"

# ---- 5. admin-consent Mail.Send --------------------------------------------
# An application permission is inert until it is granted. Granting it here means
# nobody has to find the right blade in the portal and click the right button.
# NOT FATAL if it fails. Granting a Microsoft Graph APPLICATION permission
# requires Global Administrator or Privileged Role Administrator — Application
# Administrator and Cloud Application Administrator are deliberately blocked
# from it by Microsoft (an app admin who could grant app permissions could
# grant themselves Directory.ReadWrite.All and escalate). An earlier version of
# this script let the 403 throw, which threw away the secret and the .env.local
# write below along with it, leaving an app registration nobody had credentials
# for. Consent is the one step that genuinely needs a different human, so it is
# the one step allowed to fail without costing the rest.
$consented = $false
$already = (Graph GET "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments").value |
           Where-Object { $_.appRoleId -eq $mailSend.id -and $_.resourceId -eq $graphSp.id }
if ($already) {
  Write-Host '==> Mail.Send already granted'
  $consented = $true
} else {
  Write-Host '==> Granting Mail.Send (admin consent)'
  try {
    Graph POST "v1.0/servicePrincipals/$($sp.id)/appRoleAssignments" @{
      principalId = $sp.id; resourceId = $graphSp.id; appRoleId = $mailSend.id
    } | Out-Null
    $consented = $true
    Write-Host '    granted.'
  } catch {
    Write-Host '    REFUSED (403). Carrying on — see the summary at the end.' -ForegroundColor Yellow
  }
}

# ---- 6. mint a client secret ------------------------------------------------
Write-Host "==> Minting a client secret ($SecretMonths months)"
$cred = Graph POST "v1.0/applications/$($app.id)/addPassword" @{
  passwordCredential = @{
    displayName   = "easyob-mail-$(Get-Date -Format 'yyyyMMdd')"
    endDateTime   = (Get-Date).AddMonths($SecretMonths).ToString('o')
  }
}
if (-not $cred.secretText) { throw 'Graph returned no secretText.' }

# ---- 7. write .env.local ----------------------------------------------------
# Backed up first: `vercel env pull` overwrites this file wholesale, and the
# sign-in script leaves the same kind of .bak for the same reason.
if (Test-Path $EnvFile) {
  Copy-Item $EnvFile "$EnvFile.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $lines = @(Get-Content $EnvFile)
} else { $lines = @() }

# `$`-escaped: Next's @next/env runs dotenv-expand, so a raw $AB inside a secret
# is silently expanded away and the value is corrupted. In the VERCEL UI do the
# opposite and paste the RAW value — Vercel stores literally.
$vals = [ordered]@{
  MAIL_GRAPH_TENANT_ID     = $tenantId
  MAIL_GRAPH_CLIENT_ID     = $app.appId
  MAIL_GRAPH_CLIENT_SECRET = $cred.secretText.Replace('$', '\$')
  MAIL_FROM_ADDRESS        = $SenderAddress
  MAIL_FROM_NAME           = $FromName
}
foreach ($k in $vals.Keys) {
  $line = "$k=$($vals[$k])"
  $idx  = [Array]::FindIndex($lines, [Predicate[string]]{ param($l) $l -match "^$k=" })
  if ($idx -ge 0) { $lines[$idx] = $line } else { $lines += $line }
}
Set-Content -Path $EnvFile -Value $lines
Write-Host "==> Wrote 5 vars to $EnvFile (secret not printed)"

# ---- 8. what is still outstanding ------------------------------------------
Write-Host ''
Write-Host '============================================================'
if (-not $consented) {
  Write-Host ' BLOCKED: Mail.Send is NOT granted. Nothing can send yet.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host ' Granting a Graph APPLICATION permission needs Global Admin or'
  Write-Host ' Privileged Role Administrator. Application/Cloud Application'
  Write-Host ' Administrator cannot do it, by design.'
  Write-Host ''
  Write-Host ' Easiest fix - a Global Admin opens this and clicks'
  Write-Host ' "Grant admin consent for AIO":'
  Write-Host ''
  Write-Host "   https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/$($app.appId)"
  Write-Host ''
  Write-Host ' Or a Global Admin re-runs this script - it is idempotent and'
  Write-Host ' will pick up exactly here.'
  Write-Host ''
}
Write-Host ' ALSO OUTSTANDING: Mail.Send is TENANT-WIDE until fenced -'
Write-Host ' this app can send as ANY mailbox. Needs Exchange Administrator:'
Write-Host ''
Write-Host '   Connect-ExchangeOnline'
Write-Host "   New-ApplicationAccessPolicy -AppId $($app.appId) ``"
Write-Host "     -PolicyScopeGroupId '$ScopeGroup' -AccessRight RestrictAccess ``"
Write-Host "     -Description 'EasyOB transactional mail: documents mailbox only'"
Write-Host ''
Write-Host "   Test-ApplicationAccessPolicy -Identity $SenderAddress -AppId $($app.appId)"
Write-Host '============================================================'
