if (-not (Get-ADUser -Filter "SamAccountName -eq 'TheBadGuy'" -EA SilentlyContinue)) {
  New-ADUser -Name "TheBadGuy" -GivenName "Henry" -Surname "The Bad Guy" `
    -SamAccountName "TheBadGuy" -UserPrincipalName "thebadguy" `
    -EmailAddress "thebadguy@others.com" -Path "CN=Users,DC=ntnxlab,DC=local" `
    -AccountPassword (ConvertTo-SecureString 'MyPassword4Prod!' -AsPlainText -Force) `
    -Enabled $true -ChangePasswordAtLogon $false -CannotChangePassword $true
} else {
  Write-Host "User 'TheBadGuy' already exists, skipping."
}

if (-not (Get-ADUser -Filter "SamAccountName -eq 'TheProjectManager'" -EA SilentlyContinue)) {
  New-ADUser -Name "TheProjectManager" -GivenName "Paul" -Surname "Project Manager" `
    -SamAccountName "TheProjectManager" -UserPrincipalName "theprojectmanager" `
    -EmailAddress "theprojectmanager@others.com" -Path "CN=Users,DC=ntnxlab,DC=local" `
    -AccountPassword (ConvertTo-SecureString 'MyPassword4Proj!' -AsPlainText -Force) `
    -Enabled $true -ChangePasswordAtLogon $false -CannotChangePassword $true
} else {
  Write-Host "User 'TheProjectManager' already exists, skipping."
}