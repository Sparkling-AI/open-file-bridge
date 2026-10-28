# Task: resolve Chrome Web Store Blue Argon warning for 3.7.5

Owner: Claude Code implementation worker, supervised through Orca orchestration.
Status: implementation and documentation reconciliation succeeded; local
candidate verified and ready for release integration/review (2026-10-28).

Publication authorization (2026-10-28, after review): the user requested a
commit and push, followed by the `v3.7.5` tag so CI builds the release package.
Publish the remediation branch and then the tag; Chrome Web Store submission
remains separate. The extension is 3.7.5; the unchanged skill stays 3.7.4 and
its minimum extension requirement stays 3.4.0. The original implementation
dispatch boundaries below describe that earlier phase; this later instruction
authorizes the Git publication steps.

- Run: `run_521cdc00748c`.
- Task: `task_3884772798b9`.
- Dispatch: `ctx_d80f6d675c26`.
- Worker: `term_8e3033ea-a34a-4f67-a200-949fa8319b85`.
- Isolated workspace:
  `/Users/dandanwei/orca/workspaces/open-file-bridge/cws-3.7.5-rhc`.
- Launch receipt: state `ready`; prompt accepted and `turn_started` observed.
- Agent: Claude Code, using its configured default model and effort.

## Coordinator verification checkpoint

The implementation worker reported success on 2026-10-28. The coordinator
independently passed vendor patch reproducibility, all 31 loader-guard checks,
policy scans of the source tree and candidate ZIP, the expected failure of the
original 3.7.4 ZIP, skill/client synchronization, bridge-path cases, all 26
review regressions, and `git diff --check`. Every candidate ZIP member matches
the corresponding worker source file. Relative to the original artifact,
exactly six files changed and `vendor/tesseractjs/PATCHES.json` was added.

- Candidate:
  `/Users/dandanwei/orca/workspaces/open-file-bridge/cws-3.7.5-rhc/dist-extension/open-file-bridge-extension-3.7.5.zip`.
- SHA-256:
  `5ee88c947a3b85187501be1cc23b87d9dfc9159500773c76d48a60b076767d39`.
- Worker report: `.private/notes/cws-3.7.5-remediation-report.md` in the worker
  workspace. Browser evidence at `/private/tmp/ofb-rhc-161513/results.json`
  records 29 checks, all passing, and 8 packaged-worker spawns. These are
  worker-run browser results inspected by the coordinator; the coordinator
  did not repeat the browser run.
- Network isolation used external DNS blocking and netlog inspection, rather
  than a general network firewall. The saved evidence shows no unexpected
  engine/CDN request. Picker-driven stage-3 suites were not rerun on macOS.
- A documentation-only follow-up reconciled stale prose counts and qualified
  the network/tracking-state claims: Task `task_cac18d74a830`, Dispatch
  `ctx_32bc09458763`, outcome succeeded. The coordinator checked the corrected
  report, confirmed the candidate hash and all packaged source bytes remained
  unchanged, and accepted the result. The follow-up changed only the report
  and `docs/CHROME-WEB-STORE.md`.
- The Claude terminal was released after both results were accepted; its
  transcript was archived. The isolated worktree and artifacts are preserved.
- All implementation changes remain uncommitted in the isolated worktree.
  No merge, push, release, store submission, or production change occurred.

## Target and outcome

Prepare a focused, locally verified Open File Bridge extension 3.7.5 candidate
that removes Tesseract's remotely hosted code paths and prevents their return.
Preserve working local OCR, language switching, PDF processing, existing bridge
contracts, and compatibility with the current extension skills/client.

The user authorized this remediation after an investigation and a package-wide
scan. Google issued a warning for version 3.7.4 on 2026-10-28, reference
**Blue Argon**, item `dgadccaipdgeclmompfcmmaknfdhgnee`, routing ID `FZSL`.
The notice requires an approved replacement within its 30-day warning period.

## Evidence and findings

Read the full local audit before editing:
`.private/notes/remote-code-audit-3.7.4-2026-10-28.md`.

Audited artifact: `dist-extension/open-file-bridge-extension-3.7.4.zip`.
SHA-256: `1b2922a1accd4c71b94613a1e65612ba9bd1633c23cd031e43437a57a5925595`.
All 74 packaged files matched the workspace at the audit checkpoint. The scan
included all nine wheel archives and their 778 Python source files. It found no
additional confirmed remote-code loading path outside Tesseract; this is not a
guarantee of store approval or a substitute for runtime verification.

1. **RHC-1 — remote worker default.**
   `extension/vendor/tesseractjs/tesseract.min.js`, line 2, contains the default
   `https://cdn.jsdelivr.net/npm/tesseract.js@v7.0.0/dist/worker.min.js`.
   It feeds Worker creation directly or a blob's `importScripts`.
2. **RHC-2 — remote core-loader default.**
   `extension/vendor/tesseractjs/worker.min.js`, line 2, defaults to
   `https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0`, appends a core
   JavaScript filename, and calls `importScripts`. An intercepted execution
   check reproduced this path when `corePath` was omitted.
3. **DATA-1 — remote language-model fallback.**
   The same worker defaults to `https://cdn.jsdelivr.net/npm/@tesseract.js-data/`
   for `.traineddata` files. These are data, not a separately confirmed
   executable-code violation; remove the fallback to enforce local-only OCR.
4. **Prevention gap.**
   `.github/workflows/extension.yml` validates first-party syntax/regressions and
   archives the tracked extension, but does not inspect vendored code and the
   resulting ZIP for executable remote-loading paths.

`extension/engine-impl.js:100-105` already supplies packaged worker/core/language
paths and `workerBlobURL:false`. Those application-level overrides do not
remove the executable defaults from the bundled libraries. Google explicitly
requires removal of unused remote-code loading paths as well.

## Required changes

- Remove the worker and core CDN alternatives from the actual packaged
  Tesseract bundles. Use explicit packaged-only paths or local defaults, with
  clear failures for missing/invalid paths. Enforce that code paths resolve to
  this extension's packaged resources; reject external origins and blob/data
  code paths. Do not hide URLs, weaken CSP, or rely on existing overrides alone.
- Remove the language-data CDN fallback. Keep the bundled language set and
  return a useful failure for missing/unsupported local models.
- Make vendor modifications reproducible and version-checked: provide a small
  deterministic patch/build procedure with upstream versions and integrity
  checks. It must fail if the upstream input changes and support verification
  of the committed result. Update `extension/vendor/NOTICE.md`, which currently
  describes all vendor files as unmodified. Preserve license information.
- Review the three fixed-string `Function`/`new Function` compatibility
  fallbacks in the Tesseract bundles. They are not confirmed RHC findings.
  Remove obsolete fallbacks if this is a small, justified CSP cleanup for
  supported Chrome versions; do not broaden the task into dependency rewrites.
- Add a meaningful release check covering vendored executable loading paths
  and the final ZIP, plus required local assets. It must catch the original
  worker and core fallbacks, including their assembled URLs. Distinguish
  executable URLs from harmless documentation, licenses, namespaces and data.
  Integrate the check into the extension CI/package workflow.
- Bump the extension to 3.7.5, maintain manifest/FS version consistency, and
  update release/submission documentation with the actual change and evidence.
  Do not bump skill/client compatibility floors without a real contract change.
- Prepare a correctly rooted local 3.7.5 ZIP and checksum containing the fixed
  files. Do not accidentally archive stale HEAD while the fixes are uncommitted.
  Preserve the original 3.7.4 ZIP as evidence. Record the packaging procedure.

## Ownership and boundaries

The worker owns the Tesseract remediation, focused loader/asset guards if
needed, vendor provenance/patch tooling, relevant regression checks, extension
CI, version/release documentation, and its implementation report. The
coordinator owns review, task accounting, and any follow-up dispatch.

- Work only in the workspace explicitly assigned by Orca; inspect its
  instructions and Git status first. Preserve unrelated local work.
- The main workspace has existing changes to these screenshots; do not edit,
  revert, stage, or include them:
  `docs/screenshots/cws-1-options-fresh.png`,
  `docs/screenshots/cws-2-options-security.png`,
  `docs/screenshots/cws-3-options-ocr-safety.png`.
- Do not implement the deferred scripting/permission-scope redesign, change
  broad content-script matches, or alter unrelated recovery UX and skills.
- Back up configuration files before editing them; place backups in an ignored
  task-specific directory outside `extension/` so they cannot enter the ZIP.
- No commits, pushes, merges, GitHub releases, store upload/publication, appeals,
  account changes, or production/Cloud Run changes are authorized by this task.
  Deliver a local reviewable patch/candidate. Do not use real user files or
  credentials for tests. Do not launch additional agents.
- If a required check cannot run, report the precise blocker through the live
  orchestration ask channel; never replace missing evidence with a success claim.

## Observable acceptance and verification

1. **No remote executable fallback:** source and candidate-ZIP scans find no
   Tesseract worker/core CDN loader, including unused branches. Relevant negative
   cases reject remote, cross-extension, blob and data code paths. Missing local
   code assets fail clearly without any remote fallback.
2. **Local language behavior:** English, Swedish, combined languages, and worker
   recreation on language changes work. Missing/unsupported language models fail
   usefully and do not trigger an outbound request.
3. **Real Chrome execution:** use a fresh disposable browser profile and
   synthetic fixtures. Exercise OCR and searchable-PDF creation with external
   HTTP(S) requests blocked, and verify recognized text survives PDF extraction.
   Cover both packaged SIMD core selections, forcing the capability result when
   necessary and documenting the technique. Confirm the supported engine-host
   paths still initialize. Record observed request URLs/errors and test output;
   a mocked Worker or static scan alone does not satisfy this criterion.
4. **Meaningful regressions:** run focused new tests and the existing extension
   consistency/review checks required by CI. Run existing engine tests when the
   local environment supports them; identify any unrun suite explicitly. Verify
   the prevention check rejects a copy of the original 3.7.4 artifact while
   accepting the fixed candidate for the intended reasons.
5. **Reproducibility:** demonstrate patch verification/reapplication for the
   pinned vendor inputs. Check version consistency, ZIP integrity, root
   `manifest.json`, required workers/cores/models, absence of backup/temp files,
   and SHA-256. Confirm packaged fixed files match the reviewed sources.
6. **Report:** create
   `.private/notes/cws-3.7.5-remediation-report.md` with the change summary,
   findings addressed, modified paths, exact commands and outcomes, browser
   evidence, artifact path/hash, and limitations. Supply concise proposed
   reviewer notes; do not submit them externally.

Read coordinator messages at natural checkpoints and immediately before
completion. Report completion through the exact live Orca Task/Dispatch
preamble with an explicit outcome; a timeout is not completion.

## Policy references

- [Removing remotely hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- [Additional requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

The implementation worker should check these primary sources when preparing
the compliance explanation. A local fix does not itself clear the store warning.
