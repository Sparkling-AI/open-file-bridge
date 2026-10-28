# Vendored third-party assets — Open File Bridge extension

First-party extension code stays in the parent directory, as-authored (not
minified). Everything in `extension/vendor/` is third-party data/engine
code, version-pinned. Since 3.7.5 (CWS "Blue Argon" remediation) the two
tesseract.js bundles are **patched, not unmodified** — see the patch section
below; all other vendor files remain byte-for-byte as published upstream.

| Path | What | Version | License | Source |
|---|---|---|---|---|
| `tessdata-fast/*.traineddata` | tesseract LSTM language data (fast), 8 languages + osd: eng swe dan nor deu fra spa chi_sim | tessdata_fast @ main (fetched 2026-09-06) | Apache-2.0 | github.com/tesseract-ocr/tessdata_fast |
| `tesseractjs/tesseract.min.js`, `worker.min.js` | tesseract.js browser library — **patched** (see below) | 7.0.0 | Apache-2.0 | npm: tesseract.js |
| `tesseractjs/tesseract-core-*-lstm.wasm{,.js}` | tesseract wasm core (LSTM, simd + relaxedsimd variants) | 7.0.0 | Apache-2.0 | npm: tesseract.js-core |
| `pdfium/index.esm.js`, `pdfium.wasm` | PDFium compiled to WebAssembly + TypeScript wrapper | @hyzyla/pdfium 2.1.13 (pdfium @ googlesource) | Apache-2.0 (wrapper), BSD-3-Clause (PDFium) | npm: @hyzyla/pdfium |
| `pdflib/pdf-lib.min.js` | pdf-lib UMD bundle (PDF writer: split/merge/rotate output, searchable-PDF assembly) | 1.17.1 | MIT | npm: pdf-lib (dist bundle as shipped upstream) |
| `wheels/*.whl` | pure-Python wheels for the Pyodide office stack (same set as the desktop app's src/wheels; 9 since 3.4.0 — adds olefile for Outlook `.msg` metadata) | see filenames | per-wheel (MIT/Apache-2.0/BSD) | mirrored from src/wheels |

Sizes (2026-10-20): tessdata-fast 32.4 MB (22 language files + osd),
tesseractjs 13.9 MB, pdfium 4.3 MB, pdflib 0.5 MB, wheels 2.6 MB — total ~54 MB.

Language set is a packaging variable (top-8 + osd per the Stage-3 plan);
each language is one self-contained `.traineddata` file.

## Tesseract patches (3.7.5, 2026-10-28)

`tesseract.min.js` and `worker.min.js` are regenerated from the pinned
upstream inputs in `vendor-upstream/tesseract.js-7.0.0/` by
`scripts/vendor-patch-tesseract.mjs` (SHA-256-pinned, deterministic;
`apply` regenerates, `verify` proves the committed files reproduce). The
per-file patch list and hashes also ship inside the package as
`tesseractjs/PATCHES.json`. Audit background:
`.private/notes/remote-code-audit-3.7.4-2026-10-28.md`.

The patches remove the library's remote-loading defaults — required by the
Chrome Web Store remotely-hosted-code policy even though this extension
always overrode them with packaged paths:

- **Worker default (RHC-1):** the `cdn.jsdelivr.net` worker.min.js default
  is gone; worker spawning accepts only same-extension
  `chrome-extension://…/…` URLs, and the blob-`importScripts` worker
  wrapper is deleted outright.
- **Core default (RHC-2):** the `cdn.jsdelivr.net` tesseract.js-core
  default is gone; `corePath` is required and must be packaged, and the
  assembled core URL is re-checked immediately before `importScripts`.
- **Language data (DATA-1):** the `@tesseract.js-data` CDN fallback is
  gone; `langPath` is required and must be packaged, and a missing packaged
  model fails with an explicit "no remote fallback" error.
- **CSP cleanup:** three dead eval-based compatibility fallbacks
  (`new Function("return this")`, two `Function("r","regeneratorRuntime…")`)
  are replaced with their always-taken non-eval branches; unreachable in
  supported Chrome, but no reason to ship `eval`-shaped code under MV3 CSP.

Everything else in the two bundles is upstream tesseract.js 7.0.0 as
published (Apache-2.0; license text at
<https://github.com/naptha/tesseract.js/blob/main/LICENSE>).
