# Open File Bridge privacy policy

Last updated: 1 September 2026

Open File Bridge is a local desktop application published by Sparkling AI AB.
It lets a user give compatible browser-based software controlled access to
folders that the user explicitly selects.

## Data handled by the application

Open File Bridge processes file names, file contents, configuration settings,
and local audit records needed to perform the actions requested by the user.
The application listens only on the local loopback interface (`127.0.0.1`) and
does not make the bridge available to other computers on the network.

## Collection and transmission

Open File Bridge does not include advertising, analytics, telemetry, user
accounts, or a Sparkling AI AB cloud service. It does not automatically upload
files or audit records to Sparkling AI AB.

When the user connects Open File Bridge to another application or AI service,
that other application may request file operations and may receive the results
that the user authorizes. The other application's privacy terms apply to its
handling of any data it receives.

## Storage and deletion

Configuration, versions, trash, and audit records are stored on the user's own
device. The user can remove the application and delete its local application
data. Some retained versions or trash entries may remain until the user deletes
the Open File Bridge application-data folder.

## Security

The application limits access to user-selected folders, rejects path traversal
and symbolic-link escapes, blocks credential-like file names, supports
read-only mode, requires confirmation for destructive operations, and records
file operations in a local audit log. No security control can eliminate all
risk; users should share only folders appropriate for the software connected to
the bridge.

## Contact

Privacy questions and requests can be submitted through the project's public
support channel at <https://github.com/Sparkling-AI/open-file-bridge/issues>.
