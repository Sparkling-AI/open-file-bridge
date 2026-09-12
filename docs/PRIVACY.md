# Open File Bridge privacy policy

Last updated: 12 September 2026

Open File Bridge is published by Sparkling AI AB and ships in two forms:
the **Open File Bridge extension for Chrome** and the **Open File Bridge
desktop application**. Both give software the user controls — an Open WebUI
instance — supervised access to folders the user explicitly selects, and both
run entirely on the user's own machine.

## The Chrome extension

### Data the extension handles

- **One user-selected folder.** Access starts only after the user picks a
  folder in the browser's directory picker. The extension can read and write
  files inside that folder when the connected Open WebUI asks it to; it
  cannot reach any other location on the device.
- **Allowed-site requests.** File-operation requests are accepted only from
  web origins the user has placed on the extension's allowlist, optionally
  protected by a bridge token the user configures. The extension checks each
  request's origin against that allowlist before doing anything.
- **Open WebUI sign-in data in worker mode.** When Open WebUI runs its code
  interpreter in a worker, that worker cannot read the page's own local
  storage. On request from that page, the extension's page relay reads the
  Open WebUI sign-in token from the page's local storage and returns it to
  that same page's worker over a same-origin channel. The token never leaves
  the user's browser profile, is never sent to the extension's background
  service, and is never transmitted anywhere by the extension.
- **Retained versions and trash.** When files are written, prior versions
  and deleted-file recovery entries may be retained so the user can restore
  them. This data stays inside the browser profile until the user deletes it
  or removes the extension.

### Storage

Everything the extension keeps — settings, the folder grant, retained
versions, and trash — lives in the browser's local IndexedDB storage on the
user's device. Nothing is stored in the cloud. Removing the extension from
Chrome deletes this data.

### Collection and transmission

The extension contains no advertising, analytics, telemetry, user accounts,
or Sparkling AI AB cloud service, and it does not upload file names, file
contents, or any other data to Sparkling AI AB. The only receivers of file
data are (1) the user's own Open WebUI instance, on an origin the user
allowed, responding to a request it made, and (2) the browser-profile storage
described above. Any AI service the user connects through Open WebUI operates
under that service's own privacy terms.

### Security

- Access is limited to the single user-selected folder; requested paths are
  validated and confined to that folder.
- Requests are accepted only from origins on the user's allowlist, optionally
  with a bridge token.
- Destructive operations require interactive confirmation in the page, and
  confirmations expire automatically.
- A read-only mode is available.

## The desktop application

### Data handled by the application

Open File Bridge processes file names, file contents, configuration
settings, and local audit records needed to perform the actions requested by
the user. The application listens only on the local loopback interface
(`127.0.0.1`) and does not make the bridge available to other computers on
the network.

### Collection and transmission

The application does not include advertising, analytics, telemetry, user
accounts, or a Sparkling AI AB cloud service. It does not automatically
upload files or audit records to Sparkling AI AB.

When the user connects the application to another application or AI service,
that other application may request file operations and may receive the
results that the user authorizes. The other application's privacy terms
apply to its handling of any data it receives.

### Storage and deletion

Configuration, versions, trash, and audit records are stored on the user's
own device. The user can remove the application and delete its local
application data. Some retained versions or trash entries may remain until
the user deletes the Open File Bridge application-data folder.

### Security

The application limits access to user-selected folders, rejects path
traversal and symbolic-link escapes, blocks credential-like file names,
supports read-only mode, requires confirmation for destructive operations,
and records file operations in a local audit log. No security control can
eliminate all risk; users should share only folders appropriate for the
software connected to the bridge.

## Contact

Privacy questions and requests can be submitted through the project's public
support channel at <https://github.com/Sparkling-AI/open-file-bridge/issues>.
