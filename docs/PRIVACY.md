# Open File Bridge privacy policy

Last updated: 26 October 2026

Open File Bridge is published by Sparkling AI AB and ships in two forms:
the **Open File Bridge extension for Chrome** and the **Open File Bridge
desktop application**. Both give software the user controls — an Open WebUI
instance — supervised access to folders the user explicitly selects, and both
run entirely on the user's own machine.

## The Chrome extension

### Data the extension handles

- **User-selected folders.** Access starts only after the user picks a
  folder in the browser's directory picker, and only for the folders the
  user picks (several may be shared, each with its own read/write setting).
  The extension can read and write files inside those folders when the
  connected Open WebUI asks it to; it cannot reach any other location on
  the device.
- **Selected file contents.** The extension processes the contents of files
  the user chooses to share and operations the connected Open WebUI requests.
  Those files may contain personal or sensitive information. The extension
  uses the bytes only to perform the requested file operation; it does not
  independently seek out sensitive information or use it for advertising,
  profiling, credit decisions or unrelated purposes.
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
- **Retained versions and trash.** Before a file is overwritten, its prior
  contents are normally copied so the user can restore them, subject to
  snapshot size limits and filesystem availability. Deleted files are moved
  instead of being erased. Both are kept as ordinary files **inside the
  user-selected folder itself** (in the hidden `.ofb-snapshots` and
  `.ofb-trash` folders), so they are as reachable — and as removable — as
  the user's own files.

### Storage and deletion

Two different kinds of data are involved, and they are deleted differently:

- **Browser-side data.** Settings, the folder grants, the optional bridge
  token, the confirmation state, and the local activity log are stored in
  the extension's own browser storage (IndexedDB) on the user's device.
  Removing the extension from Chrome deletes this data.
- **Recovery files in the shared folder(s).** Retained versions
  (`.ofb-snapshots/<timestamp>/<original path>`) and deleted files
  (`.ofb-trash/<timestamp>/<original path>`) are written as normal files
  inside the folder the user selected. They are NOT part of the browser
  profile: uninstalling the extension does **not** remove them, and they
  are visible to anyone the folder is shared with. Deleted-file entries are
  swept automatically 30 days after deletion; retained versions are kept
  until the user removes them. Both can be deleted at any time with the
  ordinary file manager, exactly like the
  user's other files; the settings page's recovery guide shows where they
  are.

The extension does not provide developer-operated cloud storage. Recovery
data is written only inside the folders the user selected. If those folders
are on a network drive or synchronized by another service, that service's
storage and sharing rules also apply.

### Collection and transmission

The extension contains no advertising, analytics, telemetry, user accounts,
or built-in Sparkling AI AB data-collection service. It does not automatically
upload file names, file contents or other data to developer-selected servers.
It returns requested file-operation results to the Open WebUI origin the user
explicitly allowed, including file contents when requested. Settings and
activity records are stored in the browser profile; writes and recovery
copies are stored in the selected folders as described above.

The allowed Open WebUI instance may run on another computer or a hosted
server. That instance and any AI provider the user connects to it may receive
and process the requested file data remotely under their own privacy terms.
Local processing by the extension does not mean that all data remains on the
computer after it is returned to the connected application.

### Security

- Access is limited to the user-selected folders; every requested path is
  validated and confined to one of them.
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
