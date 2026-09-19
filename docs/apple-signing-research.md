# Apple Developer ID signing, notarization, and CI for OpenCode Desktop

Research notes for distributing OpenCode Desktop as a macOS Electron app outside the Mac App Store (`.dmg` / `.zip`). Claims below are from Apple, electron-builder, Electron, GitHub, and this repo. Each claim has a source URL.

**This repo today**

- Workflow: `.github/workflows/build-desktop.yml` — `CSC_IDENTITY_AUTO_DISCOVERY: false`, artifacts `.dmg` and `.zip`.
- Config: `packages/desktop/electron-builder.config.ts` — `identity: null`, `notarize: false`, `hardenedRuntime: false`, `gatekeeperAssess: false`, `dmg.sign: false`.
- Entitlements: `packages/desktop/resources/entitlements.plist`.
- electron-builder version: `26.15.2` ([`packages/desktop/package.json`](../packages/desktop/package.json)). Current electron-builder docs default to v27; this file cites both and maps CI changes to **v26 keys this repo actually uses**.

**URL corrections (requested pages that 404 or redirected)**

| Requested | Current |
| --- | --- |
| https://developer.apple.com/support/certificates/ | Redirects to [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview) |
| https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates | [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) |
| https://developer.apple.com/help/account/manage-identifiers | 404. Use [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id) |
| https://developer.apple.com/documentation/security/hardeneed-runtime | Typo. Correct: [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime) |
| https://www.electron.build/code-signing | 404. Use [Code Signing](https://www.electron.build/docs/features/code-signing/) (v27) or [v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/) |
| https://www.electron.build/mac | Now [macOS](https://www.electron.build/docs/mac) |
| https://www.electron.build/configuration/mac | 404. Mac options live on [macOS](https://www.electron.build/docs/mac) |
| https://www.electron.build/app-builder-lib.interface.macoptions | 404. Same [macOS](https://www.electron.build/docs/mac) page |

---

## Order of operations

1. Enroll in the Apple Developer Program.
2. Register App IDs for `ai.opencode.desktop.dev`, `ai.opencode.desktop.beta`, `ai.opencode.desktop` (optional for unsigned-capability Developer ID; still unique bundle IDs).
3. Create a CSR, then a **Developer ID Application** certificate. Do **not** create Developer ID Installer unless you ship `.pkg`. Do **not** create Apple Development / Apple Distribution for this distribution path.
4. Install the `.cer` (pairs with the CSR private key). Export the identity as `.p12`. Base64-encode for CI.
5. Create an App Store Connect **Team** API key (Issuer ID, Key ID, `.p8`). Individual keys cannot use notarytool.
6. Add GitHub Actions secrets.
7. Change this repo’s workflow + electron-builder config: enable Hardened Runtime, Developer ID signing, notarize, staple.
8. Build, notarize, staple, then verify with `spctl` / `stapler` / `codesign`.

---

## 1. Apple Developer Program membership (Developer ID)

Paid Apple Developer Program membership is required to get Developer ID certificates and to notarize.

- Membership is **$99 USD / year** (local currency where available). ([Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment), [Apple Developer Program](https://developer.apple.com/programs/))
- Enrollment needs an Apple Account with two-factor authentication, and the enrollee must be the legal age of majority. ([Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment))
- You can enroll as an individual or as an organization. Organizations need legal-entity status, a D-U-N-S Number (except government), legal binding authority, a work email on the org domain, and a public website. ([Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment))
- A free Apple developer account can test on your own devices with Xcode. It cannot distribute apps or get Developer ID. ([Apple Developer Program](https://developer.apple.com/programs/), [Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment))
- Apple’s Developer ID page: a Developer ID certificate lets Gatekeeper verify software downloaded outside the Mac App Store; you can also notarize. You must be the **Account Holder** to generate the certificate. ([Signing your apps for Gatekeeper](https://developer.apple.com/developer-id/), [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))
- Electron’s code-signing guide: enroll in the Apple Developer Program, install Xcode, generate/install signing certificates. ([Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing))
- `@electron/osx-sign`: you must be a registered Apple Developer Program member; Apple may charge for the required certificates. ([electron/osx-sign](https://github.com/electron/osx-sign))

If membership expires: users can still download, install, and run already Developer ID–signed apps. After the **certificate** expires you need an active membership to get new Developer ID certificates for updates. ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates), [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

---

## 2. Certificates: create vs skip

### Create: Developer ID Application

Purpose: “Sign a Mac app before distributing it outside the Mac App Store.” ([Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

Apple: “Developer ID Application: A certificate used to sign a Mac app.” ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))

Notarization requires a Developer ID application / kext / system extension / installer certificate. Do **not** use Mac Distribution, ad hoc, Apple Developer, or local development. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

Limits: up to **five** Developer ID Application certificates. Required role: **Account Holder**. Cloud-managed Developer ID is available to admins with that access. ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))

Only Account Holder or Admin can create distribution certificates (exception: Developer ID, which is Account Holder). If enrolled as an individual, you are the Account Holder. ([Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

electron-builder: Developer ID Application is for direct distribution (DMG, ZIP, PKG). ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/), [Code Signing](https://www.electron.build/docs/features/code-signing/))

`@electron/osx-sign` identity name: `Developer ID Application: * (*)` ([electron/osx-sign](https://github.com/electron/osx-sign))

### Do not create for this app: Developer ID Installer

Purpose: “Sign and distribute a Mac Installer Package, containing your signed app, outside the Mac App Store.” ([Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

OpenCode Desktop targets are `dmg` and `zip` only (`packages/desktop/electron-builder.config.ts`). That is not a `.pkg`.

electron-builder: Developer ID Installer is for PKG files. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

`@electron/osx-sign`: “if you only want to distribute outside the Mac App Store, there is no need to have the 3rd Party Mac Developer ones installed”; Developer ID Installer is listed for outside-MAS **installer packages**. ([electron/osx-sign](https://github.com/electron/osx-sign))

### Do not create for this distribution path: Apple Development / Apple Distribution

| Type | Purpose | Source |
| --- | --- | --- |
| Apple Development | Run apps on devices and use some services during development | [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview) |
| Apple Distribution | Test on designated devices or submit to App Store Connect | [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview) |
| Mac App Distribution | Sign a Mac app before submitting to the Mac App Store | [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview) |
| Mac Installer Distribution | Sign a Mac Installer Package for the Mac App Store | [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview) |

Notarization explicitly rejects Mac Distribution, ad hoc, Apple Developer, and local development certificates. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

electron-builder: Apple Development / Mac Developer are for local testing / `mas-dev`. Apple Distribution / Mac App Distribution are for the Mac App Store. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

### WWDR / Developer ID intermediates (install, do not “create”)

You do not create intermediates. Apple issues them. Xcode can install them; otherwise download from Apple PKI.

WWDR intermediates and associated leaf types ([WWDR intermediate certificates](https://developer.apple.com/help/account/certificates/wwdr-intermediate-certificates)):

| Intermediate | Primary use | Associated certificates |
| --- | --- | --- |
| G3 | Software signing and services | Apple Development, Apple Distribution, iOS Development/Distribution, Mac Development, Mac App Distribution, Mac Installer Distribution, Swift Package Collection, Merchant Identity |
| G2 / G4 / G5 / G6 / G7 | Other (Apple Pay, APNs, App Store, Swift signing, receipts) | Not Developer ID Application |

**Developer ID uses a different intermediate**, not WWDR G3. Apple PKI lists:

- [Developer ID - G1](https://www.apple.com/certificateauthority/DeveloperIDCA.cer) (expiring 02/01/2027 22:12:15 UTC)
- [Developer ID - G2](https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer) (expiring 09/17/2031 00:00:00 UTC)

([Apple PKI](https://www.apple.com/certificateauthority/))

TN3161: typical Developer ID chain is leaf → Developer ID Certification Authority → Apple Root CA. Intermediates are on Apple PKI. `codesign` embeds the chain in the CMS blob so user machines do not need the intermediate installed. If signing fails with `unable to build chain to self-signed root`, install the missing intermediate. ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates))

WWDR G3 expires 02/20/2030. The previous WWDR intermediate expired 02/07/2023. ([WWDR intermediate certificates](https://developer.apple.com/help/account/certificates/wwdr-intermediate-certificates), [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

Expired Developer ID Application: users can still download, install, and run versions signed while the cert was valid; you need a new cert for updates. Revoked: users can no longer install those apps. ([Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

---

## 3. Click path: create Developer ID Application

Account: https://developer.apple.com/account/resources ([Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources))

### 3a. Certificate signing request (on a Mac)

From [Create a certificate signing request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request):

1. Open Keychain Access (`/Applications/Utilities`).
2. Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority.
3. User Email Address: your email.
4. Common Name: a name for the key (example in Apple’s doc: `Gita Kumar Dev Key`).
5. Leave CA Email Address empty.
6. Choose **Saved to disk**, Continue.
7. Save the `.certSigningRequest`.

This creates a public/private key pair in the login keychain and wraps the public key in the CSR. The private key never leaves the Mac. After Apple issues the `.cer`, importing it forms the identity with that private key. ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates))

### 3b. Issue the certificate on developer.apple.com

From [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) (Account Holder):

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources).
2. Sidebar: **Certificates**.
3. Top left: **+**.
4. Under Software, select **Developer ID**, Continue.
5. Choose **Developer ID Application** (not Installer), Continue.
6. Follow the CSR steps above if needed.
7. **Choose File** → select the `.certSigningRequest` → Choose.
8. Continue.
9. Download. A `.cer` lands in `Downloads`.
10. Double-click the `.cer` to install. It appears under **My Certificates** in Keychain Access.

`@electron/osx-sign` also documents creating certs at [Certificates, Identities & Profiles add](https://developer.apple.com/account/resources/certificates/add). ([electron/osx-sign](https://github.com/electron/osx-sign))

### 3c. What to download / export

| Item | What it is | Keep? |
| --- | --- | --- |
| `.certSigningRequest` | CSR public key wrapper | Optional after issuance |
| `.cer` | Certificate only (no private key) | Yes, but **cannot sign** by itself ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)) |
| Keychain identity (cert + private key) | Digital identity | Yes — this is what signs |
| `.p12` / `.pfx` | PKCS#12 export of the identity | Yes, for CI. Apple tools prefer PKCS#12 ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)) |
| Developer ID G2 (or G1) intermediate | Chain of trust | Install if `codesign` cannot build the chain ([Apple PKI](https://www.apple.com/certificateauthority/), [TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)) |

Do not share Apple certificates outside the organization. ([Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview))

---

## 4. App ID / bundle identifier

OpenCode Desktop `appId` values (`packages/desktop/electron-builder.config.ts`):

| Channel | Bundle ID |
| --- | --- |
| `OPENCODE_CHANNEL=dev` | `ai.opencode.desktop.dev` |
| `OPENCODE_CHANNEL=beta` | `ai.opencode.desktop.beta` |
| `OPENCODE_CHANNEL=prod` | `ai.opencode.desktop` |

electron-builder `appId` becomes `CFBundleIdentifier`. Use reverse-DNS. Changing it after first release breaks user data paths. ([macOS](https://www.electron.build/docs/mac))

`@electron/osx-sign`: unique Bundle ID required. ([electron/osx-sign](https://github.com/electron/osx-sign))

### Register an App ID (click path)

From [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id). Role: Account Holder or Admin.

An App ID identifies the app in a **provisioning profile** (explicit = one app; wildcard = a set). Beginning with Xcode 11.4, one App ID can cover iOS, macOS, tvOS, and watchOS.

1. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources) → sidebar **Identifiers** → **+**.
2. Select **App IDs**, Continue.
3. Confirm App ID type, Continue.
4. Description: e.g. `OpenCode Desktop`, `OpenCode Desktop Dev`, `OpenCode Desktop Beta`.
5. **Explicit App ID**. Bundle ID must match Xcode / electron-builder:
   - `ai.opencode.desktop`
   - `ai.opencode.desktop.dev`
   - `ai.opencode.desktop.beta`
6. Enable capabilities only if you will use them. Hardened Runtime JIT / library-validation exceptions are **not** App ID capabilities; they are unrestricted macOS entitlements (see §12).
7. Continue → review → **Register**. Repeat for each bundle ID.

macOS does **not** require a profile to run third-party code. A Mac app with no restricted entitlements does not need a profile. ([TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles))

Registering the three explicit App IDs is still useful so the IDs are reserved and so you can add restricted capabilities later (CloudKit, push, etc.).

---

## 5. Hardened Runtime + Electron entitlements

Notarization requires Hardened Runtime. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

Hardened Runtime + SIP block code injection, DLL hijacking, and process-memory tampering. It disables some capabilities (including JIT) unless you add exception entitlements. Use only what you need. Default of these booleans is false; do not embed an entitlement set to false. ([Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime))

electron-builder: Hardened Runtime is required for notarization on 10.15+. Default `true` for `darwin`, `false` for MAS. ([macOS](https://www.electron.build/docs/mac))

This repo currently sets `hardenedRuntime: false`.

### Entitlements already in `packages/desktop/resources/entitlements.plist`

| Key | Apple meaning | OpenCode note |
| --- | --- | --- |
| `com.apple.security.cs.allow-jit` | Writable+executable memory via `MAP_JIT` | Required for V8 / Electron ([allow-jit](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit), [electron-builder notarization](https://www.electron.build/docs/features/code-signing/notarization)) |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Writable+executable memory without `MAP_JIT` | Electron internals; Apple: security risk ([allow-unsigned-executable-memory](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory)) |
| `com.apple.security.cs.disable-executable-page-protection` | Disables code-signing protections at launch/runtime | Apple: **extreme**; prefer narrower entitlements ([disable-executable-page-protection](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-executable-page-protection)) |
| `com.apple.security.cs.allow-dyld-environment-variables` | Honor `DYLD_*` (code injection) | electron-builder sample marks this as debugging — **remove for production** ([allow-dyld-environment-variables](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables), [macOS](https://www.electron.build/docs/mac)) |
| `com.apple.security.cs.disable-library-validation` | Load libraries not signed by Apple / same Team ID | Needed for some plugins / ad-hoc vs Electron.framework Team ID; Gatekeeper extra-checks apps that disable it ([disable-library-validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)) |
| `com.apple.security.device.audio-input` | Mic / Core Audio input | Matches `NSMicrophoneUsageDescription` in config ([audio-input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)) |

Notarization also forbids `com.apple.security.get-task-allow` = true. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)) This plist does not include it.

Entitlements must be XML ASCII, no BOM. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

Include a secure timestamp (`codesign --timestamp`). Xcode archive/export adds it; custom workflows must. Timestamp server: `timestamp.apple.com`. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

electron-builder signs the app and nested frameworks/helpers when a valid identity is available. ([macOS Signing](https://www.electron.build/docs/features/code-signing/code-signing-mac))

---

## 6. Notarization (`notarytool`)

Starting **November 1, 2023**, Apple notary service no longer accepts `altool` or Xcode 13 or earlier. Use `notarytool` or Xcode 14+. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Signing your apps for Gatekeeper](https://developer.apple.com/developer-id/))

Notarization is not App Review. It scans for malware and signing issues and returns a ticket. Gatekeeper can fetch the ticket online; stapling attaches it for offline use. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

Accepted containers: macOS apps, non-app bundles, UDIF disk images, flat installer packages, ZIP. You cannot upload a raw `.app`; zip it (e.g. `ditto -c -k --keepParent`). Nested containers are processed (DMG → pkg → app). ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

Rules that apply to software built after June 1, 2019 and distributed with Developer ID (macOS 10.15+): notarize. Software on the Mac App Store is not notarized this way. Beginning 10.14.5, software signed with a **new** Developer ID cert must be notarized. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

### Credentials: Apple ID + app-specific password

App Store Connect requires 2FA. Create an app-specific password for `notarytool`. ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [App-specific passwords](https://support.apple.com/en-us/HT204397))

Create an app-specific password ([App-specific passwords](https://support.apple.com/en-us/102654) — current article; HT204397 redirects here):

1. Sign in at [account.apple.com](https://account.apple.com).
2. Sign-In and Security → App-Specific Passwords.
3. Generate an app-specific password.
4. Paste it where the app asks for the Apple Account password.

You can have up to 25 active app-specific passwords. Changing the primary Apple Account password revokes all of them. ([App-specific passwords](https://support.apple.com/en-us/102654))

Store credentials in the keychain instead of plaintext:

```sh
xcrun notarytool store-credentials "notarytool-password" \
  --apple-id "<AppleID>" \
  --team-id <DeveloperTeamID> \
  --password <secret_2FA_password>
```

Submit:

```sh
xcrun notarytool submit OvernightTextEditor_11.6.8.zip \
  --keychain-profile "notarytool-password" \
  --wait
```

([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

electron-builder env vars for this option: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. ([macOS](https://www.electron.build/docs/mac), [Notarization](https://www.electron.build/docs/features/code-signing/notarization))

### Credentials: App Store Connect API key (preferred for CI)

electron-builder recommends API keys over Apple ID for security. ([macOS](https://www.electron.build/docs/mac) citing [electron-builder#7859](https://github.com/electron-userland/electron-builder/issues/7859))

**Use a Team key. Individual keys cannot use notarytool.** ([Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api))

#### Create a Team API key (click path)

Admin in App Store Connect. ([Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api))

1. Log in to [App Store Connect](https://appstoreconnect.apple.com/).
2. **Users and Access** → **Integrations**.
3. Left column: **App Store Connect API**.
4. **Team Keys** tab.
5. **Generate API Key** or **+**.
6. Name (reference only).
7. Access: select a role (same roles as users; [Program Roles](https://developer.apple.com/support/roles/)).
8. **Generate**.

The page shows name, **Key ID**, download link. Apple does not keep the private key. Download once.

Download:

1. Users and Access → Integrations → App Store Connect API → Team Keys.
2. **Download API Key** next to the key → `.p8`.

Issuer ID ([Generating Tokens for API Requests](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)):

1. Users and Access → Integrations.
2. Issuer ID is near the top. **Copy**.

Key ID: Users and Access → Integrations; hover a key ID → Copy Key ID. JWT `kid` is this Key ID; payload `iss` is the Issuer ID UUID. Algorithm `ES256`. ([Generating Tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests))

electron-builder env vars: `APPLE_API_KEY` (base64 of `.p8` in their CI docs), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, plus `APPLE_TEAM_ID`. ([Notarization](https://www.electron.build/docs/features/code-signing/notarization), [macOS](https://www.electron.build/docs/mac))

You can also talk to the Notary API with the same App Store Connect JWT instead of `notarytool`. ([Notary API](https://developer.apple.com/documentation/notaryapi), [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

Keep API keys out of git and client-side code. Revoke if lost. ([Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api))

Always download the notary log even on success (`xcrun notarytool log <id> ...`). ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

Limit: 75 notarizations per day. Most finish in 5 minutes; 98% within 15. ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

---

## 7. Stapling

After success, Gatekeeper can find the ticket online (including for copies downloaded before notarization). Staple so offline Gatekeeper still works. ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

```sh
xcrun stapler staple "Overnight TextEditor.app"
```

Works on app, bundle, disk image, or flat installer package.

**ZIP cannot be stapled.** Staple each item, then re-zip. Standalone binaries get tickets but cannot be stapled today. ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

For OpenCode: staple the `.app` (and the `.dmg` if you notarize the DMG). Rebuild the `.zip` from the stapled `.app`.

electron-builder staples automatically when `notarize: true`. ([Notarization](https://www.electron.build/docs/features/code-signing/notarization))

`stapler` uses CloudKit (port 443, listed Apple IP ranges). ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow))

Verify:

```sh
spctl --assess --verbose --type exec dist/mac/MyApp.app
xcrun stapler validate dist/mac/MyApp.app
codesign --verify --deep --strict --verbose=2 dist/mac/MyApp.app
```

([Notarization](https://www.electron.build/docs/features/code-signing/notarization), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

---

## 8. electron-builder CI environment variables

This repo uses electron-builder **26.15.2**. v26 env vars: [v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/). v27 pages: [Code Signing](https://www.electron.build/docs/features/code-signing/), [Notarization](https://www.electron.build/docs/features/code-signing/notarization), [macOS](https://www.electron.build/docs/mac), [GitHub Actions](https://www.electron.build/docs/features/github-actions).

Never commit certificates or passwords. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

### Signing

| Variable | Purpose |
| --- | --- |
| `CSC_LINK` | HTTPS URL, `file://` path, local path, or **base64** `.p12`/`.pfx` |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `CSC_NAME` | Keychain identity name (macOS, when several identities exist) |
| `CSC_IDENTITY_AUTO_DISCOVERY` | `true` (default) / `false` — auto-select identity from keychain |
| `CSC_KEYCHAIN` | Keychain name if `CSC_LINK` unset |
| `CSC_INSTALLER_LINK` / `CSC_INSTALLER_KEY_PASSWORD` | Developer ID Installer for **PKG only** — not needed here |

This workflow currently sets `CSC_IDENTITY_AUTO_DISCOVERY: false`, which skips keychain auto-discovery. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

### Notarization (one of three sets)

From [macOS](https://www.electron.build/docs/mac) (`notarize` option):

1. `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (recommended)
2. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
3. `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`

[Notarization](https://www.electron.build/docs/features/code-signing/notarization) also lists `APPLE_TEAM_ID` with the API-key set.

### Publishing

| Variable | Purpose |
| --- | --- |
| `GH_TOKEN` or `GITHUB_TOKEN` | If set, default publish provider is GitHub ([publish](https://www.electron.build/docs/publish)) |
| `GITHUB_RELEASE_TOKEN` | Used instead of `GH_TOKEN`/`GITHUB_TOKEN` to **publish** the release |

electron-builder GitHub publisher: personal access token with **repo** scope; define `GH_TOKEN`. ([publish](https://www.electron.build/docs/publish))

GitHub Actions guide: use `GITHUB_TOKEN` (automatic) or a PAT with `repo`. Workflow needs `permissions: contents: write` to create releases. `--publish always` uploads; `--publish never` skips. ([GitHub Actions](https://www.electron.build/docs/features/github-actions), [publish](https://www.electron.build/docs/publish))

This workflow already uses `--publish never` and `permissions: contents: read`. Signing/notarizing artifacts does **not** require `GH_TOKEN`. Add `GH_TOKEN` / `contents: write` only if you start publishing GitHub Releases.

Beta/prod configs already set `publish: { provider: "github", owner: "anomalyco", repo: ... }`.

`forceCodeSigning: true` fails the build if no identity is found (avoids silent unsigned output). ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

---

## 9. GitHub Actions secrets vs env vars; export `.p12`; base64

Secrets are encrypted values you create at repo / environment / org level. Workflows read them as `${{ secrets.NAME }}` and typically assign them to `env:` so tools see ordinary environment variables. Secrets are not passed to forked-repo workflows (except `GITHUB_TOKEN`). Do not print secrets. ([Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions))

### Add a repository secret (click path)

From [Using secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions):

1. GitHub → repository.
2. **Settings**.
3. Security → **Secrets and variables** → **Actions**.
4. **Secrets** tab → **New repository secret**.
5. Name + value → **Add secret**.

CLI: `gh secret set SECRET_NAME` or `gh secret set SECRET_NAME < secret.txt`.

### Export `.p12` from Keychain

Apple: [Import and export keychain items](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)

1. Open Keychain Access.
2. Select the **Developer ID Application** identity (certificate **and** private key — “My Certificates”).
3. File → Export Items. If dimmed, a selected item cannot be exported.
4. Choose location. File Format: `.p12`.
5. Save. Set a password (needed to import / for `CSC_KEY_PASSWORD`).

electron-builder: File → Export Items → `.p12` with a password. Export Developer ID Application for DMG/ZIP. You can put multiple certs in one `.p12`. ([macOS Signing](https://www.electron.build/docs/features/code-signing/code-signing-mac), [GitHub Actions](https://www.electron.build/docs/features/github-actions))

PKCS#12 is the format Apple tools prefer for identities. A `.cer` has no private key and cannot sign. ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates))

### Base64 for CI

electron-builder ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/), [GitHub Actions](https://www.electron.build/docs/features/github-actions)):

```sh
base64 -i certificate.p12 | pbcopy
```

or:

```sh
base64 -i your-certificate.p12 -o /tmp/cert_encoded.txt
```

Set `CSC_LINK` to that string (no `file://` needed) and `CSC_KEY_PASSWORD` to the export password.

GitHub also documents storing Base64 blobs as secrets and decoding on the runner. Base64 is encoding, not encryption. ([Using secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions))

```sh
base64 -i cert.der -o cert.base64
gh secret set CERTIFICATE_BASE64 < cert.base64
```

On the runner: `echo $CERTIFICATE_BASE64 | base64 --decode > cert.der`.

electron-builder accepts the base64 string in `CSC_LINK` directly and builds a temporary keychain; you do not need a decode step if you follow their docs. ([GitHub Actions](https://www.electron.build/docs/features/github-actions))

Secrets larger than 48 KB need a workaround (e.g. gpg-encrypted file in the repo). ([Using secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions))

### Secrets to add for OpenCode Desktop macOS

Minimum for signed + notarized `.dmg`/`.zip` (API key path):

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64 of Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_API_KEY` | Base64 of AuthKey_*.p8 (or raw key material as electron-builder expects) |
| `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | Issuer ID UUID |
| `APPLE_TEAM_ID` | 10-character Team ID from [developer.apple.com/account](https://developer.apple.com/account) |

Alternative (Apple ID): `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` instead of the three API key secrets.

Optional: `GH_TOKEN` only if publishing releases (or use `GITHUB_TOKEN` with `contents: write`).

electron-builder’s Actions examples often name secrets `MAC_CSC_LINK` then map to `CSC_LINK` in `env:`. Either works; electron-builder reads **`CSC_LINK`**, not `MAC_CSC_LINK`. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/), [GitHub Actions](https://www.electron.build/docs/features/github-actions))

---

## 10. Why unsigned GitHub Actions macOS builds fail Gatekeeper

This workflow disables signing (`CSC_IDENTITY_AUTO_DISCOVERY: false`, `identity: null`). Artifacts are unsigned.

Gatekeeper on macOS Catalina+ requires Developer ID **and** notarization for software from outside the App Store. Unsigned / unnotarized software can expose the Mac to malware. ([Safely open apps on your Mac](https://support.apple.com/en-us/HT202491))

Exact dialogs from Apple ([Safely open apps on your Mac](https://support.apple.com/en-us/HT202491)):

- **“Apple cannot check \[app\] for malicious software”** — Apple could not notarize-check the app. Options include Move to Trash / Done, or a temporary override.
- Developer cannot be verified / app not notarized (Catalina+).
- App not from the App Store (if settings allow App Store only).
- App will damage your computer / is damaged / contains malware.

Electron documents the Sonoma dialog **“The app is damaged”** for unsigned apps, and that Windows/macOS prevent running unsigned apps without advanced manual steps. ([Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing))

electron-builder: without signing, Gatekeeper blocks; user must override. Signed but not notarized on 10.15+ is also blocked unless overridden. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

Override (not for shipping): System Settings → Privacy & Security → **Open Anyway**. ([Safely open apps on your Mac](https://support.apple.com/en-us/HT202491))

GitHub-hosted `macos-latest` has no Developer ID identity unless you inject `CSC_LINK`. Combined with this repo’s `identity: null`, output is unsigned. Downloading a `.dmg`/`.zip` from Actions artifacts quarantines it; Gatekeeper then shows the dialogs above.

TN3161: macOS can run code with non-Apple certs or no cert, but Gatekeeper blocks non-Apple certificates in practice. ([TN3161](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates), [Safely open apps on your Mac](https://support.apple.com/en-us/HT202491))

---

## 11. Ad-hoc signing (`codesign --sign -`) vs Developer ID

Notarization: do **not** use an ad hoc certificate. ([Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues))

electron-builder:

- `identity` not set: search keychain; skip if none. Does **not** ad-hoc-sign automatically.
- `identity: null`: skip signing.
- `identity: "-"`: ad-hoc (self-generated signature, no Apple Team ID).
- Certificate name: that identity.

Ad-hoc is for local dev without Developer ID. Electron.framework is signed with Apple’s Team ID, so ad-hoc + Hardened Runtime can fail with different Team IDs unless you add `com.apple.security.cs.disable-library-validation` or set `hardenedRuntime: false`. ([macOS Signing](https://www.electron.build/docs/features/code-signing/code-signing-mac), [macOS](https://www.electron.build/docs/mac))

| | Ad-hoc (`-`) | Developer ID Application |
| --- | --- | --- |
| Identity | No Apple team | Account Holder Developer ID |
| Gatekeeper | Not a trusted identified developer | Gatekeeper can verify ([Developer ID](https://developer.apple.com/developer-id/)) |
| Notarization | Rejected | Required for 10.15+ direct distribution |
| CI distribution | Users hit “cannot check for malicious software” | After notarize+staple, normal first-launch dialog |

`codesign --sign "Apple Development"` is development signing (TN3161 example), not Developer ID and not notarizable.

---

## 12. Provisioning profiles for Developer ID Electron (non-sandbox)

**Usually no.**

TN3125: Apple platforms except macOS will not run arbitrary third-party code without a profile. **macOS does not require a provisioning profile to run third-party code.** Profiles still matter on Mac for **restricted** entitlements. ([TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles))

Unrestricted on macOS (no profile): `com.apple.security.get-task-allow`, app groups, App Sandbox entitlements, **Hardened Runtime entitlements**. ([TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles))

OpenCode’s plist is all Hardened Runtime exceptions plus audio-input — unrestricted. No CloudKit, push, or other restricted entitlements.

Apple: apps that **don’t** use a Developer ID provisioning profile — Gatekeeper checks the cert at install; if it was valid at compile time, users can run after cert expiry. Apps that **do** use a Developer ID profile for advanced capabilities — profile is checked at every launch; expired profile → app will not launch. ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))

`@electron/osx-sign`: provisioning profiles are required for **Mac App Store** submission, not for outside-MAS Developer ID. ([electron/osx-sign](https://github.com/electron/osx-sign))

Hardened Runtime is listed as a Developer ID–available capability. ([Supported capabilities (macOS)](https://developer.apple.com/help/account/reference/supported-capabilities-macos))

If you later add CloudKit or push, you need a Developer ID profile (Apple: generated after 2017-02-22, valid 18 years). Embed at `MyApp.app/Contents/embedded.provisionprofile`. ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates), [TN3125](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles))

---

## Current OpenCode Desktop CI (as of this research)

`.github/workflows/build-desktop.yml`:

- `workflow_dispatch` macos / linux / all.
- macOS job: `macos-latest`, `CSC_IDENTITY_AUTO_DISCOVERY: false`, `OPENCODE_CHANNEL: dev`.
- Package: `bun run package:mac --publish never`.
- Upload `packages/desktop/dist/*.dmg` and `*.zip`.
- `permissions: contents: read`. No `CSC_*` or Apple notarization env.

`packages/desktop/electron-builder.config.ts` `mac`:

- `hardenedRuntime: false`
- `gatekeeperAssess: false`
- entitlements + entitlementsInherit → `resources/entitlements.plist`
- `identity: null`
- `notarize: false`
- `target: ["dmg", "zip"]`
- `dmg.sign: false`

That combination is an intentional unsigned build. It will not pass Gatekeeper for downloaded copies.

---

## Exact CI/CD changes for this repo (electron-builder 26)

Do not copy v27 `mac.sign.*` nesting until you upgrade past 26.15.2. ([macOS](https://www.electron.build/docs/mac) v27 breaking changes)

### A. `packages/desktop/electron-builder.config.ts`

In `getBase()` `mac` / `dmg`:

```ts
mac: {
  category: "public.app-category.developer-tools",
  icon: `resources/icons/icon.icns`,
  hardenedRuntime: true,
  gatekeeperAssess: false,
  entitlements: "resources/entitlements.plist",
  entitlementsInherit: "resources/entitlements.plist",
  notarize: true,
  target: ["dmg", "zip"],
  extendInfo: {
    NSMicrophoneUsageDescription: "OpenCode needs microphone access for voice dictation.",
  },
},
dmg: {
  sign: true,
},
```

Changes vs today:

- Remove `identity: null` so `CSC_LINK` can supply Developer ID. ([macOS Signing](https://www.electron.build/docs/features/code-signing/code-signing-mac), [macOS](https://www.electron.build/docs/mac))
- `hardenedRuntime: true` (notarization). ([Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [Notarization](https://www.electron.build/docs/features/code-signing/notarization))
- `notarize: true` and set Apple env vars. ([macOS](https://www.electron.build/docs/mac))
- `dmg.sign: true` so the disk image is signed (notary accepts UDIF images). ([Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution))

Optional: `forceCodeSigning: true` on macOS CI so missing secrets fail the job. ([v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))

Keep `gatekeeperAssess: false` unless you want `spctl` during the build (often noisy on CI).

### B. Entitlements

Keep `allow-jit` and `allow-unsigned-executable-memory`. Keep `audio-input` while voice dictation exists.

Before shipping, consider removing:

- `com.apple.security.cs.allow-dyld-environment-variables` (electron-builder: debugging only) ([macOS](https://www.electron.build/docs/mac))
- `com.apple.security.cs.disable-executable-page-protection` (Apple: extreme) ([disable-executable-page-protection](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-executable-page-protection))

Keep `disable-library-validation` only if native modules / helpers fail library validation. Apple: Gatekeeper extra-checks apps that disable it. ([disable-library-validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation))

### C. `.github/workflows/build-desktop.yml`

On the macOS job:

1. Remove `CSC_IDENTITY_AUTO_DISCOVERY: false` (or it will fight `CSC_LINK` auto-use — if you keep it false, you **must** pass `CSC_LINK` so signing is not skipped). Safer: delete it and provide `CSC_LINK`.
2. Pass secrets into the Package macOS step:

```yaml
      - name: Package macOS
        working-directory: packages/desktop
        run: bun run package:mac --publish never
        env:
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

Pattern from [v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/) and [Notarization](https://www.electron.build/docs/features/code-signing/notarization).

3. Leave `--publish never` until you want GitHub Releases. Then `permissions: contents: write` and `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` with `--publish always` or `onTag`. ([GitHub Actions](https://www.electron.build/docs/features/github-actions), [publish](https://www.electron.build/docs/publish), [Using secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions))

electron-builder creates the temporary keychain from `CSC_LINK`; no extra `security` unlock step in their current Actions docs. ([GitHub Actions](https://www.electron.build/docs/features/github-actions))

Notary needs network to S3 (`notary-submissions-prod.s3-accelerate.amazonaws.com` by default) and stapler CloudKit ranges. ([Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)) GitHub-hosted macOS runners have internet; locked-down self-hosted runners must allow those hosts.

---

## Walkthrough for a new Apple Developer (short)

1. **Enroll** — [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll), $99/year, 2FA Apple Account. Wait for confirmation. ([Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment))
2. **Identifiers** — Certificates, Identifiers & Profiles → Identifiers → + → App IDs → explicit `ai.opencode.desktop`, `.dev`, `.beta`. ([Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id))
3. **CSR** — Keychain Access → Certificate Assistant → Request a Certificate from a CA → Saved to disk. ([Create a CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request))
4. **Cert** — Certificates → + → Developer ID → **Developer ID Application** → upload CSR → download `.cer` → double-click. Skip Installer / Apple Development / Apple Distribution. ([Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates))
5. **Export** — Keychain Access, My Certificates, select Developer ID Application identity → File → Export Items → `.p12` + password. `base64 -i cert.p12`. ([Keychain export](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac), [v26 Code Signing](https://www.electron.build/v26/docs/features/code-signing/))
6. **API key** — App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate (not Individual) → download `.p8` once; copy Key ID and Issuer ID. ([Creating API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api), [Generating Tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests))
7. **GitHub** — Settings → Secrets and variables → Actions → add `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`. ([Using secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions))
8. **Repo** — enable Hardened Runtime, drop `identity: null`, `notarize: true`, `dmg.sign: true`; wire secrets into `package:mac`; drop `CSC_IDENTITY_AUTO_DISCOVERY: false`.
9. **Verify** — `codesign --verify --deep --strict -vvv`, `spctl --assess --verbose --type exec`, `xcrun stapler validate` on the `.app` / `.dmg`. ([Notarization](https://www.electron.build/docs/features/code-signing/notarization))

---

## Sources

- [Certificates overview](https://developer.apple.com/help/account/certificates/certificates-overview)
- [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Create a certificate signing request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [WWDR intermediate certificates](https://developer.apple.com/help/account/certificates/wwdr-intermediate-certificates)
- [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id)
- [Program enrollment](https://developer.apple.com/help/account/membership/program-enrollment)
- [Apple Developer Program](https://developer.apple.com/programs/)
- [Signing your apps for Gatekeeper](https://developer.apple.com/developer-id/)
- [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
- [allow-jit](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)
- [allow-unsigned-executable-memory](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory)
- [disable-library-validation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)
- [disable-executable-page-protection](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-executable-page-protection)
- [allow-dyld-environment-variables](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables)
- [audio-input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input)
- [Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Generating Tokens for API Requests](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- [Notary API](https://developer.apple.com/documentation/notaryapi)
- [TN3125 Provisioning Profiles](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles)
- [TN3161 Certificates](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)
- [Supported capabilities (macOS)](https://developer.apple.com/help/account/reference/supported-capabilities-macos)
- [Apple PKI](https://www.apple.com/certificateauthority/)
- [Safely open apps on your Mac](https://support.apple.com/en-us/HT202491)
- [App-specific passwords](https://support.apple.com/en-us/HT204397) (canonical: [102654](https://support.apple.com/en-us/102654))
- [Keychain import/export](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)
- [electron-builder Code Signing (v26)](https://www.electron.build/v26/docs/features/code-signing/)
- [electron-builder Code Signing](https://www.electron.build/docs/features/code-signing/)
- [electron-builder macOS Signing](https://www.electron.build/docs/features/code-signing/code-signing-mac)
- [electron-builder Notarization](https://www.electron.build/docs/features/code-signing/notarization)
- [electron-builder macOS](https://www.electron.build/docs/mac)
- [electron-builder GitHub Actions](https://www.electron.build/docs/features/github-actions)
- [electron-builder publish](https://www.electron.build/docs/publish)
- [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron/osx-sign](https://github.com/electron/osx-sign)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)
