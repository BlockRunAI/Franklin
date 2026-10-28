# Desktop update release setup

Customer flow: sidebar **Update Franklin** → in-app download and verification
→ **Restart to update** → the new app opens. Settings retains manual checks,
release notes, cancellation and retry. No customer Terminal commands are needed.

## One-time Apple setup

macOS automatic replacement requires a signed application. A developer account
alone does not create the signing identity. The Account Holder should:

1. In macOS Keychain Access, choose Certificate Assistant → Request a Certificate
   From a Certificate Authority. Enter the developer account email and a clear
   signing name, then save the certificate signing request to disk. Keep the
   private key in Keychain Access.
2. Open [Apple Certificates](https://developer.apple.com/account/resources/certificates/list),
   add **Developer ID Application**, upload the request, download the `.cer` and
   import it into the same keychain. This is the application certificate, not
   Developer ID Installer. See [Apple's instructions](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
3. Export the certificate **with its private key** as a password-protected `.p12`
   for CI. Keep this file outside the repository. Configure the following
   repository secrets directly in GitHub or through interactive `gh secret set`:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded `.p12` |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | Developer Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Do not paste certificate keys, the `.p12` or passwords in chat, issue/PR bodies,
logs or source files. `security find-identity -v -p codesigning` should show a
valid Developer ID Application identity after importing the certificate.

## Release safeguards

- `builder.config.cjs` permits unsigned branch/PR QA builds. A macOS release tag
  sets `FRANKLIN_SIGNED_RELEASE=1` and requires all signing/notarization inputs.
- Before signing, a resource marker enables the native Mac updater. After
  signing, the build verifies the app's Developer ID Application identity and
  Team ID. Unsigned QA builds omit the marker and retain the installer fallback.
- CI validates the signature and stapled notarization ticket for signed releases.
- macOS builds produce DMG + ZIP + `latest-mac.yml`; Windows produces NSIS +
  `latest.yml`. Artifact names are fixed at build time and are never renamed
  after update metadata is generated. CI verifies referenced files, versions,
  sizes and SHA-512 before upload. The release adds SHA256SUMS.txt.
- Branch CI never publishes installers. Public Desktop tags are published only
  after both platform jobs pass. Missing signing credentials fail the macOS
  release instead of silently publishing an unsigned auto-update build.

## Acceptance before the first signed release

1. Install a signed older QA build in a disposable profile. Stage a newer build
   signed by the same team, with its ZIP and update metadata.
2. Confirm the sidebar detects the new version without stealing focus. Click
   Update; finish a task while the download proceeds. Restart must remain
   disabled until all active chat/media/Team tasks finish.
3. Restart to update. Confirm the newly opened app reports the newer version,
   the installed bundle signature and notarization are valid, and drafts,
   settings and Skills survive.
4. Retry with a bad hash, interrupted transfer and invalid signature. No invalid
   app may replace the installed copy. Confirm network recovery is possible.

The signed macOS replacement test cannot be certified using unsigned QA builds
or a mocked installer. The current first-time users on beta.6 or earlier must
manually install a release containing the updater once. Subsequent compatible
signed releases use the in-app flow.
