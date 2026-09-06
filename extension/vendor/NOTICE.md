# Vendored third-party assets — Open File Bridge extension

Everything in `extension/vendor/` is third-party data/engine code, vendored
unmodified and version-pinned. First-party extension code stays in the
parent directory, as-authored (not minified).

| Path | What | Version | License | Source |
|---|---|---|---|---|
| `tessdata-fast/*.traineddata` | tesseract LSTM language data (fast), 8 languages + osd: eng swe dan nor deu fra spa chi_sim | tessdata_fast @ main (fetched 2026-09-06) | Apache-2.0 | github.com/tesseract-ocr/tessdata_fast |
| `tesseractjs/tesseract.min.js`, `worker.min.js` | tesseract.js browser library | 7.0.0 | Apache-2.0 | npm: tesseract.js |
| `tesseractjs/tesseract-core-*-lstm.wasm{,.js}` | tesseract wasm core (LSTM, simd + relaxedsimd variants) | 7.0.0 | Apache-2.0 | npm: tesseract.js-core |
| `pdfium/index.esm.js`, `pdfium.wasm` | PDFium compiled to WebAssembly + TypeScript wrapper | @hyzyla/pdfium 2.1.13 (pdfium @ googlesource) | Apache-2.0 (wrapper), BSD-3-Clause (PDFium) | npm: @hyzyla/pdfium |
| `wheels/*.whl` | pure-Python wheels for the Pyodide office stack (same set as the desktop app's src/wheels) | see filenames | per-wheel (MIT/Apache-2.0/BSD) | mirrored from src/wheels |

Sizes (2026-09-06): tessdata-fast 32.4 MB (9 files), tesseractjs 13.9 MB,
pdfium 4.3 MB, wheels 2.6 MB — total ~53 MB.

Language set is a packaging variable (top-8 + osd per the Stage-3 plan);
each language is one self-contained `.traineddata` file.
