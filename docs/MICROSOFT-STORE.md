# Publishing Open File Bridge in the Microsoft Store

The Store route uses an **MSIX** package. Microsoft re-signs an accepted
MSIX, so Store installs do not need a separately purchased Windows code-signing
certificate. Do not choose the Store's existing EXE/MSI listing route for this
goal: that route still requires the publisher to sign the installer.

## 1. Create the company developer account

1. Start at <https://storedeveloper.microsoft.com/>. The new onboarding flow
   has no registration fee.
2. Choose **Company**, not Individual. The account type cannot later be changed.
3. Sign in with the Microsoft Entra work account that should administer the
   Sparkling AI AB publisher.
4. Enter the legal company details exactly as registered for Sparkling AI AB
   and complete Microsoft's company verification.

Keep at least two account owners in Partner Center once onboarding is complete.

## 2. Reserve the product name and copy its identity

1. In Partner Center, open **Apps and games** and create a new product.
2. Reserve **Open File Bridge** (or the final public Store name).
3. Open **Product management → Product identity**.
4. Copy these values exactly:
   - **Package/Identity/Name**
   - **Package/Identity/Publisher**
   - **Package/Properties/PublisherDisplayName**

The first two values are machine-generated identity, not branding. Do not type
or simplify them manually. The MSIX manifest must match Partner Center exactly.

## 3. Store identity and GitHub Actions

The reserved product identity is public package metadata and is committed in
`build/msix/store-identity.json`:

| Partner Center field | Open File Bridge value |
|---|---|
| Package/Identity/Name | `SparklingAI.OpenFileBridge` |
| Package/Identity/Publisher | `CN=8D9FAB32-823C-41A9-9893-1EEDCE79B564` |
| Package/Properties/PublisherDisplayName | `Sparkling AI` |
| Store ID | `9P00JGZGGMQ3` |

Every tagged Windows build creates `OpenFileBridge-windows-x64.msix`; no
GitHub secret or repository variable is needed. The version comes from `VERSION` in
`src/file_bridge.py` and is converted from semver `x.y.z` to MSIX `x.y.z.0`.

To build locally on Windows after running PyInstaller:

```powershell
.\build\build_msix.ps1
```

`MakeAppx.exe` is supplied by the Windows 10/11 SDK. The script packages the
PyInstaller folder, Office wheels, OCR language data, Store artwork, and—when
present—`build\bundle\tesseract`.

## 4. Test before submission

1. Download the Windows artifact from GitHub Actions.
2. For a local unsigned MSIX test, use a test certificate whose subject exactly
   matches the manifest publisher, or let Partner Center perform installation
   testing after upload.
3. Launch Open File Bridge from the Start menu.
4. Confirm that the browser opens `http://127.0.0.1:8765`.
5. Select a test folder, save it, and check `/health`.
6. Run the Windows App Certification Kit if it is available on the test PC.

The package declares `runFullTrust` because it contains a conventional
PyInstaller Win32 process. It runs only with the current user's normal rights;
it does not request elevation.

## 5. Prepare the Store listing

Use the existing brand artwork and screenshots in `docs/brand/` and
`docs/screenshots/`. Partner Center will show the exact required dimensions.

Suggested short description:

> Give browser-based AI assistants controlled access to files in folders you choose, with local processing, confirmations, versions, trash, and an audit log.

Suggested `runFullTrust` justification:

> Open File Bridge is an existing Win32 desktop application packaged with
> Desktop Bridge. It starts a loopback-only HTTP service at 127.0.0.1 so code
> running in the user's browser can access only folders explicitly selected by
> that user. Full trust is required for the Python/PyInstaller desktop process,
> the native folder workflow, document conversion, and local file operations.
> The application runs at medium integrity, does not request administrator
> privileges, does not install drivers or services, and does not accept remote
> network connections.

Certification notes:

> No account or external service is required to launch and test the app. Start
> Open File Bridge from the Start menu; it opens the local settings page at
> http://127.0.0.1:8765. Select a temporary folder and save. The `/health`
> endpoint confirms that the local bridge is running. Open WebUI integration is
> optional and is not required for basic certification testing.

Listing checklist:

- Public support URL
- Public privacy-policy URL (adapt `docs/PRIVACY.md` and publish it)
- App description, category, screenshots, and age rating
- Explanation for the restricted `runFullTrust` capability
- Versioned `.msix` upload from the Windows CI artifact
- Notes explaining the loopback service and how reviewers can test it

## 6. Submit and release gradually

Upload the MSIX to the product submission, complete every validation section,
and submit it for certification. After certification, use a gradual rollout if
Partner Center offers it. Install the public Store build on a clean Windows PC
and on one managed company PC before announcing it widely.

Store signing removes SmartScreen prompts for Store installs, but an employer
can still disable Microsoft Store or restrict which Store products are allowed.
In that case the employer's IT team must approve or deploy the product through
Intune/Company Portal.

Reserved Store page: <https://apps.microsoft.com/detail/9P00JGZGGMQ3>
