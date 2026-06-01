$ErrorActionPreference = "Stop"

function Ensure-GameUser {
  param($Sam, $Given, $Surname, $Upn, $Email, $Password)
  if (Get-ADUser -Filter "SamAccountName -eq '$Sam'" -EA SilentlyContinue) {
    Write-Host "[skip] user '$Sam' already exists"
    return
  }
  New-ADUser -Name $Sam -GivenName $Given -Surname $Surname `
    -SamAccountName $Sam -UserPrincipalName $Upn `
    -EmailAddress $Email -Path "CN=Users,DC=ntnxlab,DC=local" `
    -AccountPassword (ConvertTo-SecureString $Password -AsPlainText -Force) `
    -Enabled $true -ChangePasswordAtLogon $false -CannotChangePassword $true
  Write-Host "[ok]   created user '$Sam' (UPN=$Upn)"
}

Ensure-GameUser "TheBadGuy"        "Henry" "The Bad Guy"     "thebadguy"        "thebadguy@others.com"        "MyPassword4Prod!"
Ensure-GameUser "TheProjectManager" "Paul"  "Project Manager" "theprojectmanager" "theprojectmanager@others.com" "MyPassword4Proj!"

# Verify both are present so the task log proves the end state, not just the actions.
Write-Host "--- AD users (CN=Users) ---"
foreach ($sam in @("TheBadGuy", "TheProjectManager")) {
  $u = Get-ADUser -Filter "SamAccountName -eq '$sam'" -Properties UserPrincipalName -EA SilentlyContinue
  if ($u) {
    Write-Host ("[present] {0}  UPN={1}  Enabled={2}" -f $u.SamAccountName, $u.UserPrincipalName, $u.Enabled)
  } else {
    Write-Host "[MISSING] $sam — creation failed"
  }
}
