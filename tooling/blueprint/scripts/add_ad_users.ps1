$ErrorActionPreference = "Stop"

function Ensure-GameUser {
  param($Sam, $Given, $Surname, $Upn, $Email, $Password)
  if (Get-ADUser -Filter "SamAccountName -eq '$Sam'" -EA SilentlyContinue) {
    Write-Host "[skip] user '$Sam' already exists"
    return
  }
  # Catch so a single failure doesn't abort the run — the recap below reports it.
  try {
    New-ADUser -Name $Sam -GivenName $Given -Surname $Surname `
      -SamAccountName $Sam -UserPrincipalName $Upn `
      -EmailAddress $Email -Path "CN=Users,DC=ntnxlab,DC=local" `
      -AccountPassword (ConvertTo-SecureString $Password -AsPlainText -Force) `
      -Enabled $true -ChangePasswordAtLogon $false -CannotChangePassword $true
    Write-Host "[ok]   created user '$Sam' (UPN=$Upn)"
  } catch {
    Write-Host "[FAIL] could not create '$Sam': $($_.Exception.Message)"
  }
}

Ensure-GameUser "TheBadGuy"        "Henry" "The Bad Guy"     "thebadguy"        "thebadguy@others.com"        "MyPassword4Prod!"
Ensure-GameUser "TheProjectManager" "Paul"  "Project Manager" "theprojectmanager" "theprojectmanager@others.com" "MyPassword4Proj!"

# Verify both are present so the task log proves the end state, not just the actions.
Write-Host "--- AD users (CN=Users) ---"
$missing = 0
foreach ($sam in @("TheBadGuy", "TheProjectManager")) {
  $u = Get-ADUser -Filter "SamAccountName -eq '$sam'" -Properties UserPrincipalName -EA SilentlyContinue
  if ($u) {
    Write-Host ("[present] {0}  UPN={1}  Enabled={2}" -f $u.SamAccountName, $u.UserPrincipalName, $u.Enabled)
  } else {
    Write-Host "[MISSING] $sam — creation failed"
    $missing++
  }
}
if ($missing -gt 0) { exit 1 }
