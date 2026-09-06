/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

const BYTES_PER_PIXEL = 4;
const FPDFErrorCode = {
    UNKNOWN: 1, // Unknown error.
    FILE: 2, // File not found or could not be opened.
    FORMAT: 3, // File not in PDF format or corrupted.
    PASSWORD: 4, // Password required or incorrect password.
    SECURITY: 5, // Unsupported security scheme.
    PAGE: 6, // Page not found or content error.
};
const FPDFBitmap = {
    Unknown: 0,
    Gray: 1, // Gray scale bitmap, one byte per pixel.
    BGR: 2, // 3 bytes per pixel, byte order: blue, green, red.
    BGRx: 3, // 4 bytes per pixel, byte order: blue, green, red, unused.
    BGRA: 4, // 4 bytes per pixel, byte order: blue, green, red, alpha.
};
// Page rendering flags. They can be combined with bit-wise OR.
const FPDFRenderFlag = {
    // Set if annotations are to be rendered (high-lights, sticky-notes, ink, etc.)
    ANNOT: 0x01,
    // Set if using text rendering optimized for LCD display. This flag will only
    // take effect if anti-aliasing is enabled for text.
    LCD_TEXT: 0x02,
    // Don't use the native text output available on some platforms
    NO_NATIVETEXT: 0x04,
    // Grayscale output.
    GRAYSCALE: 0x08,
    // Obsolete, has no effect, retained for compatibility.
    DEBUG_INFO: 0x80,
    // Obsolete, has no effect, retained for compatibility.
    NO_CATCH: 0x100,
    // Limit image cache size.
    RENDER_LIMITEDIMAGECACHE: 0x200,
    // Always use halftone for image stretching.
    RENDER_FORCEHALFTONE: 0x400,
    // Render for printing.
    PRINTING: 0x800,
    // Set to disable anti-aliasing on text. This flag will also disable LCD
    // optimization for text rendering.
    RENDER_NO_SMOOTHTEXT: 0x1000,
    // Set to disable anti-aliasing on images.
    RENDER_NO_SMOOTHIMAGE: 0x2000,
    // Set to disable anti-aliasing on paths.
    RENDER_NO_SMOOTHPATH: 0x4000,
    // Set whether to render in a reverse Byte order, this flag is only used when
    // rendering to a bitmap. (what Canvas likes)
    REVERSE_BYTE_ORDER: 0x10,
    // Set whether fill paths need to be stroked. This flag is only used when
    // FPDF_COLORSCHEME is passed in, since with a single fill color for paths the
    // boundaries of adjacent fill paths are less visible.
    CONVERT_FILL_TO_STROKE: 0x20,
};
const FPDFPageObjectType = {
    TEXT: 1,
    PATH: 2,
    IMAGE: 3,
    SHADING: 4,
    FORM: 5,
};

const DEFAULT_PAGE_RENDER_OPTIONS = {
    scale: 1,
    render: "bitmap",
    colorSpace: "BGRA",
    renderFormFields: false,
    transparent: false,
};

function convertBitmapToImage(options) {
    return __awaiter(this, void 0, void 0, function* () {
        const { data, render } = options;
        if (typeof render === "function") {
            return yield render(options);
        }
        return data;
    });
}
function readUInt16LE(buffer, offset = 0) {
    return buffer[offset] | (buffer[offset + 1] << 8);
}

class PDFiumObjectBase {
    constructor(options) {
        this.module = options.module;
        this.objectIdx = options.objectIdx;
        this.documentIdx = options.documentIdx;
        this.pageIdx = options.pageIdx;
    }
    static create(options) {
        const type = options.module._FPDFPageObj_GetType(options.objectIdx);
        switch (type) {
            case FPDFPageObjectType.TEXT:
                return new PDFiumTextObject(options);
            case FPDFPageObjectType.PATH:
                return new PDFiumPathObject(options);
            case FPDFPageObjectType.IMAGE:
                return new PDFiumImageObject(options);
            case FPDFPageObjectType.SHADING:
                return new PDFiumShadingObject(options);
            case FPDFPageObjectType.FORM:
                return new PDFiumFormObject(options);
            default:
                throw new Error(`Unknown object type: ${type}`);
        }
    }
}
class PDFiumTextObject extends PDFiumObjectBase {
    constructor() {
        super(...arguments);
        this.type = "text";
    }
}
class PDFiumPathObject extends PDFiumObjectBase {
    constructor() {
        super(...arguments);
        this.type = "path";
    }
}
class PDFiumImageObject extends PDFiumObjectBase {
    constructor() {
        super(...arguments);
        this.type = "image";
    }
    static formatToBPP(format) {
        switch (format) {
            case FPDFBitmap.Gray:
                return 1;
            case FPDFBitmap.BGR:
                return 3;
            case FPDFBitmap.BGRx:
            case FPDFBitmap.BGRA:
                return 4;
            default:
                throw new Error(`Unsupported bitmap format: ${format}`);
        }
    }
    /**
     * Return the raw uncompressed image data.
     */
    getImageDataRaw() {
        return __awaiter(this, void 0, void 0, function* () {
            const bufferSize = this.module._FPDFImageObj_GetImageDataRaw(this.objectIdx, 0, 0);
            if (!bufferSize) {
                throw new Error("Failed to get bitmap from image object.");
            }
            const bufferPtr = this.module.wasmExports.malloc(bufferSize);
            if (!this.module._FPDFImageObj_GetImageDataRaw(this.objectIdx, bufferPtr, bufferSize)) {
                throw new Error("Failed to get bitmap buffer.");
            }
            const oData = this.module.HEAPU8.slice(bufferPtr, bufferPtr + bufferSize);
            this.module.wasmExports.free(bufferPtr);
            // Width and height of the image in pixels will be written to these pointers as 16-bit integers (2 bytes each):
            // [ ... width (2 bytes) ... | ... height (2 bytes) ... ]
            const sizePtr = this.module.wasmExports.malloc(2 + 2);
            const widthPtr = sizePtr;
            const heightPtr = sizePtr + 2;
            if (!this.module._FPDFImageObj_GetImagePixelSize(this.objectIdx, widthPtr, heightPtr)) {
                throw new Error("Failed to get image size.");
            }
            const widthBuffer = this.module.HEAPU8.slice(widthPtr, widthPtr + 2);
            const heightBuffer = this.module.HEAPU8.slice(heightPtr, heightPtr + 2);
            this.module.wasmExports.free(sizePtr);
            const width = readUInt16LE(widthBuffer);
            const height = readUInt16LE(heightBuffer);
            const filtersCount = this.module._FPDFImageObj_GetImageFilterCount(this.objectIdx);
            const filters = [];
            for (let i = 0; i < filtersCount; i++) {
                const filterSize = this.module._FPDFImageObj_GetImageFilter(this.objectIdx, i, 0, 0);
                const filterPtr = this.module.wasmExports.malloc(filterSize);
                if (!this.module._FPDFImageObj_GetImageFilter(this.objectIdx, i, filterPtr, filterSize)) {
                    throw new Error("Failed to get image filter.");
                }
                const filterBuffer = this.module.HEAPU8.slice(filterPtr, filterPtr + filterSize - 1);
                const filter = new TextDecoder().decode(filterBuffer).trim();
                this.module.wasmExports.free(filterPtr);
                filters.push(filter);
            }
            return {
                width: width,
                height: height,
                data: oData,
                filters: filters,
            };
        });
    }
    /**
     * Render the image object to a buffer with the specified render function.
     */
    render() {
        return __awaiter(this, arguments, void 0, function* (options = {
            render: "bitmap",
        }) {
            const bitmapIdx = this.module._FPDFImageObj_GetBitmap(this.objectIdx);
            if (!bitmapIdx) {
                throw new Error("Failed to get bitmap from image object.");
            }
            const bufferPtr = this.module._FPDFBitmap_GetBuffer(bitmapIdx);
            if (!bufferPtr) {
                throw new Error("Failed to get bitmap buffer.");
            }
            // Stride is the number of bytes per row, it might be larger than width * bytesPerPixel
            // and is used for alignment in the bitmap buffer (e.g. 4-byte alignment)
            const stride = this.module._FPDFBitmap_GetStride(bitmapIdx);
            // Width and height of the image in pixels
            const width = this.module._FPDFBitmap_GetWidth(bitmapIdx);
            const height = this.module._FPDFBitmap_GetHeight(bitmapIdx);
            // Format of the image: 1 - Gray, 2 - BGR, 3 - BGRx, 4 - BGRA
            const format = this.module._FPDFBitmap_GetFormat(bitmapIdx);
            // Here is BBP (bytes per pixel) for the original image
            const oBPP = PDFiumImageObject.formatToBPP(format);
            // Calculate the buffer size of the original image, stored in the WASM heap
            const bufferSize = height * stride;
            // Get the buffer from the WASM heap to a JS Uint8Array
            const oData = this.module.HEAPU8.slice(bufferPtr, bufferPtr + bufferSize);
            this.module.wasmExports.free(bufferPtr);
            // Currently we only support converting to RGBA (4 bytes per pixel)
            const tBPP = BYTES_PER_PIXEL;
            // Create a new buffer for the target image and fill it with white color
            const tData = new Uint8Array(width * height * tBPP);
            // Fill the buffer with transparent white color
            tData.fill(255);
            // Iterate over the rows of the original and target images
            for (let rowIndex = 0; rowIndex < height; rowIndex++) {
                const tRowStart = rowIndex * tBPP * width;
                const oRowStart = rowIndex * stride;
                // Iterate over the columns of the original and target images
                for (let columnIndex = 0; columnIndex < width; columnIndex++) {
                    const tPixelStart = tRowStart + columnIndex * tBPP;
                    const oPixelStart = oRowStart + columnIndex * oBPP;
                    // conver from original format to RGBA
                    // =================
                    switch (format) {
                        case FPDFBitmap.Gray: {
                            // Grayscale: Copy the gray value to R, G, B, and set A to 255
                            const gray = oData[oPixelStart];
                            tData[tPixelStart + 0] = gray; // R
                            tData[tPixelStart + 1] = gray; // G
                            tData[tPixelStart + 2] = gray; // B
                            // A is already set to 255 by Buffer.alloc
                            break;
                        }
                        case FPDFBitmap.BGR: {
                            // BGR: Copy the values to RGB and set A to 255
                            tData[tPixelStart + 0] = oData[oPixelStart + 2]; // R
                            tData[tPixelStart + 1] = oData[oPixelStart + 1]; // G
                            tData[tPixelStart + 2] = oData[oPixelStart + 0]; // B
                            // A is already set to 255 by Buffer.alloc
                            break;
                        }
                        case FPDFBitmap.BGRx: {
                            // BGRx: Copy the values to RGB and set A to 255
                            tData[tPixelStart + 0] = oData[oPixelStart + 2]; // R
                            tData[tPixelStart + 1] = oData[oPixelStart + 1]; // G
                            tData[tPixelStart + 2] = oData[oPixelStart + 0]; // B
                            // A is already set to 255 by Buffer.alloc
                            break;
                        }
                        case FPDFBitmap.BGRA: {
                            // BGRA: Copy directly
                            tData[tPixelStart + 0] = oData[oPixelStart + 2]; // R
                            tData[tPixelStart + 1] = oData[oPixelStart + 1]; // G
                            tData[tPixelStart + 2] = oData[oPixelStart + 0]; // B
                            tData[tPixelStart + 3] = oData[oPixelStart + 3]; // A
                            break;
                        }
                        default:
                            throw new Error(`Unsupported bitmap format: ${format}`);
                    }
                    // switch case end
                    // =================
                }
            }
            const image = yield convertBitmapToImage({
                render: options.render,
                width: width,
                height: height,
                data: tData,
            });
            return {
                width: width,
                height: height,
                data: image,
            };
        });
    }
}
class PDFiumShadingObject extends PDFiumObjectBase {
    constructor() {
        super(...arguments);
        this.type = "shading";
    }
}
class PDFiumFormObject extends PDFiumObjectBase {
    constructor() {
        super(...arguments);
        this.type = "form";
    }
}

class PDFiumPage {
    constructor(options) {
        this.module = options.module;
        this.pageIdx = options.pageIdx;
        this.documentIdx = options.documentIdx;
        this.document = options.document;
        this.number = options.pageIndex;
    }
    getOriginalSize() {
        const originalWidth = this.module._FPDF_GetPageWidth(this.pageIdx);
        const originalHeight = this.module._FPDF_GetPageHeight(this.pageIdx);
        return {
            originalWidth,
            originalHeight,
        };
    }
    /**
     * Get the size of the page in points (1/72 inch)
     * Floored original values needed in testing. Scale can be a float number.
     */
    getSize(renderOptions) {
        const { scale, width, height } = renderOptions;
        const { originalHeight, originalWidth } = this.getOriginalSize();
        const computedWidth = Math.floor(width !== null && width !== void 0 ? width : originalWidth);
        const computedHeight = Math.floor(height !== null && height !== void 0 ? height : originalHeight);
        return {
            originalWidth: Math.floor(originalWidth),
            originalHeight: Math.floor(originalHeight),
            width: Math.floor(computedWidth * scale),
            height: Math.floor(computedHeight * scale),
        };
    }
    /**
     * Extract text from the page
     */
    getText() {
        const textPage = this.module._FPDFText_LoadPage(this.pageIdx);
        if (!textPage) {
            throw new Error("Failed to load text page");
        }
        try {
            const charCount = this.module._FPDFText_CountChars(textPage);
            if (charCount <= 0) {
                return "";
            }
            const bufferSize = (charCount + 1) * 2;
            const textPtr = this.module.wasmExports.malloc(bufferSize);
            try {
                const length = this.module._FPDFText_GetText(textPage, 0, charCount, textPtr);
                if (length <= 0) {
                    return "";
                }
                // Convert the UTF-16LE buffer to a JavaScript string
                // Subtract 1 from length to remove the null terminator
                const buffer = new Uint8Array(this.module.HEAPU8.buffer, textPtr, (length - 1) * 2);
                const text = new TextDecoder("utf-16le").decode(buffer);
                return text;
            }
            finally {
                this.module.wasmExports.free(textPtr);
            }
        }
        finally {
            this.module._FPDFText_ClosePage(textPage);
        }
    }
    render() {
        return __awaiter(this, arguments, void 0, function* (options = {}) {
            let formIdx = null;
            const renderOptions = Object.assign(Object.assign({}, DEFAULT_PAGE_RENDER_OPTIONS), options);
            const { colorSpace, render, renderFormFields, transparent } = renderOptions;
            const { width, height, originalWidth, originalHeight } = this.getSize(renderOptions);
            if (renderFormFields) {
                formIdx = this.document.initializeFormFields(); // will be initialized only once
                this.module._FORM_OnAfterLoadPage(this.pageIdx, formIdx);
            }
            const bytesPerPixel = FPDFBitmap[colorSpace];
            const buffSize = width * height * bytesPerPixel;
            const ptr = this.module.wasmExports.malloc(buffSize);
            let bitmap = null;
            if (ptr === 0) {
                throw new Error("Failed to allocate memory for bitmap");
            }
            try {
                bitmap = this.module._FPDFBitmap_CreateEx(width, height, bytesPerPixel, ptr, width * bytesPerPixel);
                // Gray bitmaps have no alpha channel, so transparency only applies to BGRA.
                const fillColor = transparent && colorSpace === "BGRA" ? 0x00000000 : 0xffffffff;
                this.module._FPDFBitmap_FillRect(bitmap, 0, // left
                0, // top
                width, // width
                height, // height
                fillColor);
                let flags = FPDFRenderFlag.ANNOT | FPDFRenderFlag.LCD_TEXT;
                flags = colorSpace === "Gray" ? flags | FPDFRenderFlag.GRAYSCALE : flags | FPDFRenderFlag.REVERSE_BYTE_ORDER;
                this.module._FPDF_RenderPageBitmap(bitmap, this.pageIdx, 0, // start_x
                0, // start_y
                width, // size_x
                height, // size_y
                0, // rotate (0, normal)
                flags);
                if (formIdx !== null) {
                    // Second draw pass – draw the interactive form widgets on top of previously draw call
                    // Remove ANNOT flags to avoid rendering popup annotations (e.g. tooltips).
                    const formFlags = flags & ~FPDFRenderFlag.ANNOT;
                    this.module._FPDF_FFLDraw(formIdx, bitmap, this.pageIdx, 0, // start_x
                    0, // start_y
                    width, // size_x
                    height, // size_y
                    0, // rotate (0, normal)
                    formFlags);
                    this.module._FORM_OnBeforeClosePage(this.pageIdx, formIdx);
                }
                const image = yield this.convertBitmapToImage({
                    render,
                    width,
                    height,
                    // ⚠️ creation of a copy is necessary to avoid memory corruption
                    data: this.module.HEAPU8.slice(ptr, ptr + buffSize),
                });
                return {
                    width,
                    height,
                    originalHeight,
                    originalWidth,
                    data: image,
                };
            }
            finally {
                // always clean up resources in case of success / error
                if (bitmap !== null) {
                    this.module._FPDFBitmap_Destroy(bitmap);
                }
                // TODO: consider to create a separate function for closing the page and free resources only when needed, not after every render
                this.module._FPDF_ClosePage(this.pageIdx);
                this.module.wasmExports.free(ptr);
            }
        });
    }
    convertBitmapToImage(options) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield convertBitmapToImage(options);
        });
    }
    getObjectCount() {
        return this.module._FPDFPage_CountObjects(this.pageIdx);
    }
    getObject(i) {
        const object = this.module._FPDFPage_GetObject(this.pageIdx, i);
        return PDFiumObjectBase.create({
            module: this.module,
            objectIdx: object,
            documentIdx: this.documentIdx,
            pageIdx: this.pageIdx,
        });
    }
    *objects() {
        const objectsCount = this.getObjectCount();
        for (let i = 0; i < objectsCount; i++) {
            yield this.getObject(i);
        }
    }
}

class PDFiumDocument {
    constructor(options) {
        // Form handle for rendering and interacting with form fields
        this.formIdx = null;
        this.formPtr = null;
        this.module = options.module;
        this.documentPtr = options.documentPtr;
        this.documentIdx = options.documentIdx;
    }
    /**
     * Initialize form environment for this document
     * This is required for rendering form fields such as signatures.
     * @returns The form handle
     */
    initializeFormFields() {
        if (this.formIdx !== null) {
            return this.formIdx;
        }
        // Initialize the form fill environment by allocating a structure with list of
        // callbacks that PDFium will call when it needs to interact with the form.
        // The structure is defined in PDFium as follows (simplified):
        //
        // typedef struct _FPDF_FORMFILLINFO {
        //     int  version;                                   // 1st field (we use 2)
        //     void (*Release)(struct _FPDF_FORMFILLINFO*);    // callback #1
        //     void (*FFI_Invalidate)(struct _FPDF_FORMFILLINFO*, …); // callback #2
        //     …
        // } FPDF_FORMFILLINFO;
        //
        const formSize = 256; // we need at least 140 bytes, but let's allocate 256 for safety
        this.formPtr = this.module.wasmExports.malloc(formSize);
        if (this.formPtr === 0) {
            throw new Error("Failed to allocate memory for form fill environment");
        }
        this.module.HEAPU8.fill(0, this.formPtr, this.formPtr + formSize);
        // Set "version" field to 2. Version 2 supports XFA and other features
        new DataView(this.module.HEAPU8.buffer).setUint32(this.formPtr, 2, true);
        this.formIdx = this.module._FPDFDOC_InitFormFillEnvironment(this.documentIdx, this.formPtr);
        if (this.formIdx === 0) {
            this.module.wasmExports.free(this.formPtr);
            this.formPtr = null;
            throw new Error("Failed to initialize form fill environment");
        }
        return this.formIdx;
    }
    /**
     * Get a page from the document by its index. The index is zero-based.
     */
    getPage(pageIndex) {
        const pageIdx = this.module._FPDF_LoadPage(this.documentIdx, pageIndex);
        return new PDFiumPage({
            module: this.module,
            pageIdx: pageIdx,
            documentIdx: this.documentIdx,
            pageIndex: pageIndex,
            document: this,
        });
    }
    /**
     * User-friendly iterator to iterate over all pages in the document.
     */
    *pages() {
        const pageCount = this.getPageCount();
        for (let i = 0; i < pageCount; i++) {
            yield this.getPage(i);
        }
    }
    /**
     * Get the number of pages in the document.
     */
    getPageCount() {
        return this.module._FPDF_GetPageCount(this.documentIdx);
    }
    /**
     * After you're done with the document, you should destroy it to free the memory.
     *
     * Otherwise, you'll be fired from your job for causing a memory leak. 😱
     */
    destroy() {
        if (this.formIdx) {
            this.module._FPDFDOC_ExitFormFillEnvironment(this.formIdx);
            this.formIdx = null;
        }
        if (this.formPtr) {
            this.module.wasmExports.free(this.formPtr);
            this.formPtr = null;
        }
        this.module._FPDF_CloseDocument(this.documentIdx);
        this.module.wasmExports.free(this.documentPtr);
    }
}

/**
 * From Emscripten project
 */
/**
 * Returns the number of bytes the given Javascript string takes if encoded as a
 * UTF8 byte array, EXCLUDING the null terminator byte.
 *
 * @param {string} str - JavaScript string to operator on
 * @return {number} Length, in bytes, of the UTF8 encoded string.
 */
function lengthBytesUTF8(str) {
    let len = 0;
    for (let i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
        // unit, not a Unicode code point of the character! So decode
        // UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        const c = str.charCodeAt(i); // possibly a lead surrogate
        if (c <= 0x7f) {
            len++;
        }
        else if (c <= 0x7ff) {
            len += 2;
        }
        else if (c >= 0xd800 && c <= 0xdfff) {
            len += 4;
            ++i;
        }
        else {
            len += 3;
        }
    }
    return len;
}
/**
 * Copies the given Javascript String object 'str' to the given byte array at
 * address 'outIdx', encoded in UTF8 form and null-terminated. The copy will
 * require at most str.length*4+1 bytes of space in the HEAP.  Use the function
 * lengthBytesUTF8 to compute the exact number of bytes (excluding null
 * terminator) that this function will write.
 *
 * @param {string} str - The Javascript string to copy.
 * @param {ArrayBufferView|Array<number>} heap - The array to copy to. Each
 *                                               index in this array is assumed
 *                                               to be one 8-byte element.
 * @param {number} outIdx - The starting offset in the array to begin the copying.
 * @param {number} maxBytesToWrite - The maximum number of bytes this function
 *                                   can write to the array.  This count should
 *                                   include the null terminator, i.e. if
 *                                   maxBytesToWrite=1, only the null terminator
 *                                   will be written and nothing else.
 *                                   maxBytesToWrite=0 does not write any bytes
 *                                   to the output, not even the null
 *                                   terminator.
 * @return {number} The number of bytes written, EXCLUDING the null terminator.
 */
function stringToUTF8(str, heap, outIdx, maxBytesToWrite) {
    outIdx >>>= 0;
    // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
    // undefined and false each don't write out any bytes.
    if (!(maxBytesToWrite > 0))
        return 0;
    const startIdx = outIdx;
    const endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
    for (let i = 0; i < str.length; ++i) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
        // unit, not a Unicode code point of the character! So decode
        // UTF16->UTF32->UTF8.
        // See http://unicode.org/faq/utf_bom.html#utf16-3
        // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
        // and https://www.ietf.org/rfc/rfc2279.txt
        // and https://tools.ietf.org/html/rfc3629
        let u = str.charCodeAt(i); // possibly a lead surrogate
        if (u >= 0xd800 && u <= 0xdfff) {
            const u1 = str.charCodeAt(++i);
            u = (0x10000 + ((u & 0x3ff) << 10)) | (u1 & 0x3ff);
        }
        if (u <= 0x7f) {
            if (outIdx >= endIdx)
                break;
            heap[outIdx++] = u;
        }
        else if (u <= 0x7ff) {
            if (outIdx + 1 >= endIdx)
                break;
            heap[outIdx++] = 0xc0 | (u >> 6);
            heap[outIdx++] = 0x80 | (u & 63);
        }
        else if (u <= 0xffff) {
            if (outIdx + 2 >= endIdx)
                break;
            heap[outIdx++] = 0xe0 | (u >> 12);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        }
        else {
            if (outIdx + 3 >= endIdx)
                break;
            heap[outIdx++] = 0xf0 | (u >> 18);
            heap[outIdx++] = 0x80 | ((u >> 12) & 63);
            heap[outIdx++] = 0x80 | ((u >> 6) & 63);
            heap[outIdx++] = 0x80 | (u & 63);
        }
    }
    // Null-terminate the pointer to the buffer.
    heap[outIdx] = 0;
    return outIdx - startIdx;
}

const NO_OPTION_WARNING = "@hyzyla/pdfium: wasmUrl, wasmBinary is required for browser environment. \n\n" +
    "Please provide the wasm binary or URL to the init method. You can also use '@hyzyla/pdfium/browser/cdn'" +
    "or '@hyzyla/pdfium/browser/base64' for quick setup, but it's not recommended for production use.";
/**
 * Converts a JavaScript string to a null-terminated C string and returns
 * a pointer to the allocated memory.
 *
 * Remember to free the allocated memory using the `free` function after
 * you're done with the string.
 */
function stringToCString(module, str) {
    // Get the length of the UTF-8 string including the null terminator
    const length = lengthBytesUTF8(str) + 1;
    // Allocate memory for the string
    const passwordPtr = module.wasmExports.malloc(length);
    // Copy the string to the allocated memory
    stringToUTF8(str, module.HEAPU8, passwordPtr, length);
    return passwordPtr;
}
let PDFiumLibrary$1 = class PDFiumLibrary {
    static initBase(options) {
        return __awaiter(this, void 0, void 0, function* () {
            const { wasmUrl, wasmBinary, instantiateWasm } = options || {};
            const loadOptions = {};
            if (wasmUrl) {
                loadOptions.locateFile = (_path) => wasmUrl;
            }
            else if (wasmBinary) {
                loadOptions.wasmBinary = wasmBinary;
                // Also set a no-op locateFile so the vendor's findWasmBinary short-circuits
                // before its `new URL(..., import.meta.url)` call, which throws inside
                // blob-based worker contexts (issue #40). The returned URL is never read
                // because wasmBinary is provided.
                loadOptions.locateFile = () => "";
            }
            else if (instantiateWasm) {
                loadOptions.instantiateWasm = instantiateWasm;
            }
            else {
                // Node.js will use wasm binary from node_modules, but for browser environment,
                // user must provide the wasm binary or URL
                if (typeof window !== "undefined") {
                    console.error(NO_OPTION_WARNING);
                    throw new Error(NO_OPTION_WARNING);
                }
            }
            const module = yield options.vendor(loadOptions);
            module._FPDF_InitLibraryWithConfig({
                version: 2,
                m_pIsolate: null,
                m_pUserFontPaths: null,
                m_v8EmbedderSlot: 0,
                m_pPlatform: null,
            });
            return new PDFiumLibrary(module);
        });
    }
    constructor(module) {
        this.module = module;
    }
    loadDocument(buff_1) {
        return __awaiter(this, arguments, void 0, function* (buff, password = "") {
            const size = buff.length;
            // This line allocates a block of memory of size bytes and returns a pointer to the first byte of the block.
            //  The malloc function is a standard C library function for memory allocation, and here it's exposed via
            // this.module.asm, which likely represents the compiled WebAssembly module. The returned pointer (ptr) is
            // an integer value representing the memory location within the WebAssembly module's memory space.
            const documentPtr = this.module.wasmExports.malloc(size);
            // This line copies the content of buff into the WebAssembly module's memory starting at the address specified by ptr.
            // Here HEAPU8 is a typed array that serves as a view into the WebAssembly memory, allowing JavaScript code to read
            // and write bytes directly. The set method is used to copy the contents of an array (buff in this case) into HEAPU8
            // starting at the index ptr.
            this.module.HEAPU8.set(buff, documentPtr);
            // This line converts the password string to a null-terminated C string and returns a pointer
            // to the allocated memory. Don't forget to free the allocated memory using the free function after you're
            // done with the string.
            let passwordPtr = 0;
            if (password) {
                passwordPtr = stringToCString(this.module, password);
            }
            // This line reads the PDF document from the memory block starting at documentPtr and of size bytes.
            // If the document is password-protected, the password should be provided as a null-terminated C string.
            // The function returns a document index (handle) that can be used to interact with the document.
            const documentIdx = this.module._FPDF_LoadMemDocument(documentPtr, size, passwordPtr);
            // Handle error if the document could not be loaded
            if (!documentIdx) {
                const lastError = this.module._FPDF_GetLastError();
                // Free the allocated memory for the document and password before throwing
                this.module.wasmExports.free(documentPtr);
                if (passwordPtr !== 0) {
                    this.module.wasmExports.free(passwordPtr);
                }
                switch (lastError) {
                    case FPDFErrorCode.UNKNOWN:
                        throw new Error("Unknown error");
                    case FPDFErrorCode.FILE:
                        throw new Error("File not found or could not be opened");
                    case FPDFErrorCode.FORMAT:
                        throw new Error("File not in PDF format or corrupted");
                    case FPDFErrorCode.PASSWORD:
                        throw new Error("Password required or incorrect password");
                    case FPDFErrorCode.SECURITY:
                        throw new Error("Unsupported security scheme");
                    case FPDFErrorCode.PAGE:
                        throw new Error("Page not found or content error");
                    default:
                        throw new Error(`PDF Loading = ${lastError}`);
                }
            }
            const document = new PDFiumDocument({
                module: this.module,
                documentPtr: documentPtr,
                documentIdx: documentIdx,
            });
            // Free the allocated memory for the password string
            if (passwordPtr !== null) {
                this.module.wasmExports.free(passwordPtr);
            }
            return document;
        });
    }
    destroy() {
        this.module._FPDF_DestroyLibrary();
    }
};

var PDFiumModule = (() => {
  return async function (moduleArg = {}) {
    var moduleRtn;

    var Module = moduleArg;
    var ENVIRONMENT_IS_WEB = typeof window == "object";
    var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
    var ENVIRONMENT_IS_NODE = typeof process == "object" && process.versions?.node && process.type != "renderer";
    var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;
    if (ENVIRONMENT_IS_NODE) {
      const { createRequire } = await import('module');
      var require = createRequire(import.meta.url);
    }
    var thisProgram = "./this.program";
    var _scriptName = import.meta.url;
    var scriptDirectory = "";
    function locateFile(path) {
      if (Module["locateFile"]) {
        return Module["locateFile"](path, scriptDirectory);
      }
      return scriptDirectory + path;
    }
    var readAsync, readBinary;
    if (ENVIRONMENT_IS_NODE) {
      const isNode = typeof process == "object" && process.versions?.node && process.type != "renderer";
      if (!isNode)
        throw new Error(
          "not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)",
        );
      var nodeVersion = process.versions.node;
      var numericVersion = nodeVersion.split(".").slice(0, 3);
      numericVersion = numericVersion[0] * 1e4 + numericVersion[1] * 100 + numericVersion[2].split("-")[0] * 1;
      if (numericVersion < 16e4) {
        throw new Error("This emscripten-generated code requires node v16.0.0 (detected v" + nodeVersion + ")");
      }
      var fs = require("fs");
      if (_scriptName.startsWith("file:")) {
        scriptDirectory = require("path").dirname(require("url").fileURLToPath(_scriptName)) + "/";
      }
      readBinary = (filename) => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename);
        assert(Buffer.isBuffer(ret));
        return ret;
      };
      readAsync = async (filename, binary = true) => {
        filename = isFileURI(filename) ? new URL(filename) : filename;
        var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
        assert(binary ? Buffer.isBuffer(ret) : typeof ret == "string");
        return ret;
      };
      if (process.argv.length > 1) {
        thisProgram = process.argv[1].replace(/\\/g, "/");
      }
      process.argv.slice(2);
    } else if (ENVIRONMENT_IS_SHELL) {
      const isNode = typeof process == "object" && process.versions?.node && process.type != "renderer";
      if (isNode || typeof window == "object" || typeof WorkerGlobalScope != "undefined")
        throw new Error(
          "not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)",
        );
    } else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
      try {
        scriptDirectory = new URL(".", _scriptName).href;
      } catch {}
      if (!(typeof window == "object" || typeof WorkerGlobalScope != "undefined"))
        throw new Error(
          "not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)",
        );
      {
        if (ENVIRONMENT_IS_WORKER) {
          readBinary = (url) => {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, false);
            xhr.responseType = "arraybuffer";
            xhr.send(null);
            return new Uint8Array(xhr.response);
          };
        }
        readAsync = async (url) => {
          if (isFileURI(url)) {
            return new Promise((resolve, reject) => {
              var xhr = new XMLHttpRequest();
              xhr.open("GET", url, true);
              xhr.responseType = "arraybuffer";
              xhr.onload = () => {
                if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) {
                  resolve(xhr.response);
                  return;
                }
                reject(xhr.status);
              };
              xhr.onerror = reject;
              xhr.send(null);
            });
          }
          var response = await fetch(url, { credentials: "same-origin" });
          if (response.ok) {
            return response.arrayBuffer();
          }
          throw new Error(response.status + " : " + response.url);
        };
      }
    } else {
      throw new Error("environment detection error");
    }
    var out = console.log.bind(console);
    var err = console.error.bind(console);
    assert(
      !ENVIRONMENT_IS_SHELL,
      "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.",
    );
    var wasmBinary;
    if (typeof WebAssembly != "object") {
      err("no native wasm support detected");
    }
    var ABORT = false;
    function assert(condition, text) {
      if (!condition) {
        abort("Assertion failed" + (text ? ": " + text : ""));
      }
    }
    var isFileURI = (filename) => filename.startsWith("file://");
    function writeStackCookie() {
      var max = _emscripten_stack_get_end();
      assert((max & 3) == 0);
      if (max == 0) {
        max += 4;
      }
      HEAPU32[max >> 2] = 34821223;
      HEAPU32[(max + 4) >> 2] = 2310721022;
      HEAPU32[0 >> 2] = 1668509029;
    }
    function checkStackCookie() {
      if (ABORT) return;
      var max = _emscripten_stack_get_end();
      if (max == 0) {
        max += 4;
      }
      var cookie1 = HEAPU32[max >> 2];
      var cookie2 = HEAPU32[(max + 4) >> 2];
      if (cookie1 != 34821223 || cookie2 != 2310721022) {
        abort(
          `Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`,
        );
      }
      if (HEAPU32[0 >> 2] != 1668509029) {
        abort("Runtime error: The application has corrupted its heap memory area (address zero)!");
      }
    }
    (() => {
      var h16 = new Int16Array(1);
      var h8 = new Int8Array(h16.buffer);
      h16[0] = 25459;
      if (h8[0] !== 115 || h8[1] !== 99)
        throw "Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)";
    })();
    function consumedModuleProp(prop) {
      if (!Object.getOwnPropertyDescriptor(Module, prop)) {
        Object.defineProperty(Module, prop, {
          configurable: true,
          set() {
            abort(
              `Attempt to set \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`,
            );
          },
        });
      }
    }
    function makeInvalidEarlyAccess(name) {
      return () => assert(false, `call to '${name}' via reference taken before Wasm module initialization`);
    }
    function ignoredModuleProp(prop) {
      if (Object.getOwnPropertyDescriptor(Module, prop)) {
        abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
      }
    }
    function isExportedByForceFilesystem(name) {
      return (
        name === "FS_createPath" ||
        name === "FS_createDataFile" ||
        name === "FS_createPreloadedFile" ||
        name === "FS_unlink" ||
        name === "addRunDependency" ||
        name === "FS_createLazyFile" ||
        name === "FS_createDevice" ||
        name === "removeRunDependency"
      );
    }
    function hookGlobalSymbolAccess(sym, func) {
      if (typeof globalThis != "undefined" && !Object.getOwnPropertyDescriptor(globalThis, sym)) {
        Object.defineProperty(globalThis, sym, {
          configurable: true,
          get() {
            func();
            return undefined;
          },
        });
      }
    }
    function missingGlobal(sym, msg) {
      hookGlobalSymbolAccess(sym, () => {
        warnOnce(`\`${sym}\` is not longer defined by emscripten. ${msg}`);
      });
    }
    missingGlobal("buffer", "Please use HEAP8.buffer or wasmMemory.buffer");
    missingGlobal("asm", "Please use wasmExports instead");
    function missingLibrarySymbol(sym) {
      hookGlobalSymbolAccess(sym, () => {
        var msg = `\`${sym}\` is a library symbol and not included by default; add it to your library.js __deps or to DEFAULT_LIBRARY_FUNCS_TO_INCLUDE on the command line`;
        var librarySymbol = sym;
        if (!librarySymbol.startsWith("_")) {
          librarySymbol = "$" + sym;
        }
        msg += ` (e.g. -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='${librarySymbol}')`;
        if (isExportedByForceFilesystem(sym)) {
          msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
        }
        warnOnce(msg);
      });
      unexportedRuntimeSymbol(sym);
    }
    function unexportedRuntimeSymbol(sym) {
      if (!Object.getOwnPropertyDescriptor(Module, sym)) {
        Object.defineProperty(Module, sym, {
          configurable: true,
          get() {
            var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
            if (isExportedByForceFilesystem(sym)) {
              msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
            }
            abort(msg);
          },
        });
      }
    }
    var readyPromiseResolve, readyPromiseReject;
    var wasmMemory;
    var HEAP8, HEAPU8, HEAP16, HEAP32, HEAPU32;
    var HEAP64;
    var runtimeInitialized = false;
    function updateMemoryViews() {
      var b = wasmMemory.buffer;
      Module["HEAP8"] = HEAP8 = new Int8Array(b);
      Module["HEAP16"] = HEAP16 = new Int16Array(b);
      Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
      Module["HEAPU16"] = new Uint16Array(b);
      Module["HEAP32"] = HEAP32 = new Int32Array(b);
      Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
      Module["HEAPF32"] = new Float32Array(b);
      Module["HEAPF64"] = new Float64Array(b);
      HEAP64 = new BigInt64Array(b);
      new BigUint64Array(b);
    }
    assert(
      typeof Int32Array != "undefined" &&
        typeof Float64Array !== "undefined" &&
        Int32Array.prototype.subarray != undefined &&
        Int32Array.prototype.set != undefined,
      "JS engine does not provide full typed array support",
    );
    function preRun() {
      if (Module["preRun"]) {
        if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
        while (Module["preRun"].length) {
          addOnPreRun(Module["preRun"].shift());
        }
      }
      consumedModuleProp("preRun");
      callRuntimeCallbacks(onPreRuns);
    }
    function initRuntime() {
      assert(!runtimeInitialized);
      runtimeInitialized = true;
      checkStackCookie();
      if (!Module["noFSInit"] && !FS.initialized) FS.init();
      wasmExports["__wasm_call_ctors"]();
      FS.ignorePermissions = false;
    }
    function postRun() {
      checkStackCookie();
      if (Module["postRun"]) {
        if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
        while (Module["postRun"].length) {
          addOnPostRun(Module["postRun"].shift());
        }
      }
      consumedModuleProp("postRun");
      callRuntimeCallbacks(onPostRuns);
    }
    var runDependencies = 0;
    var dependenciesFulfilled = null;
    var runDependencyTracking = {};
    var runDependencyWatcher = null;
    function addRunDependency(id) {
      runDependencies++;
      Module["monitorRunDependencies"]?.(runDependencies);
      if (id) {
        assert(!runDependencyTracking[id]);
        runDependencyTracking[id] = 1;
        if (runDependencyWatcher === null && typeof setInterval != "undefined") {
          runDependencyWatcher = setInterval(() => {
            if (ABORT) {
              clearInterval(runDependencyWatcher);
              runDependencyWatcher = null;
              return;
            }
            var shown = false;
            for (var dep in runDependencyTracking) {
              if (!shown) {
                shown = true;
                err("still waiting on run dependencies:");
              }
              err(`dependency: ${dep}`);
            }
            if (shown) {
              err("(end of list)");
            }
          }, 1e4);
        }
      } else {
        err("warning: run dependency added without ID");
      }
    }
    function removeRunDependency(id) {
      runDependencies--;
      Module["monitorRunDependencies"]?.(runDependencies);
      if (id) {
        assert(runDependencyTracking[id]);
        delete runDependencyTracking[id];
      } else {
        err("warning: run dependency removed without ID");
      }
      if (runDependencies == 0) {
        if (runDependencyWatcher !== null) {
          clearInterval(runDependencyWatcher);
          runDependencyWatcher = null;
        }
        if (dependenciesFulfilled) {
          var callback = dependenciesFulfilled;
          dependenciesFulfilled = null;
          callback();
        }
      }
    }
    function abort(what) {
      Module["onAbort"]?.(what);
      what = "Aborted(" + what + ")";
      err(what);
      ABORT = true;
      var e = new WebAssembly.RuntimeError(what);
      readyPromiseReject?.(e);
      throw e;
    }
    function createExportWrapper(name, nargs) {
      return (...args) => {
        assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
        var f = wasmExports[name];
        assert(f, `exported native function \`${name}\` not found`);
        assert(
          args.length <= nargs,
          `native function \`${name}\` called with ${args.length} args but expects ${nargs}`,
        );
        return f(...args);
      };
    }
    var wasmBinaryFile;
    function findWasmBinary() {
      if (Module["locateFile"]) {
        return locateFile("pdfium.wasm");
      }
      return new URL("pdfium.wasm", import.meta.url).href;
    }
    function getBinarySync(file) {
      if (file == wasmBinaryFile && wasmBinary) {
        return new Uint8Array(wasmBinary);
      }
      if (readBinary) {
        return readBinary(file);
      }
      throw "both async and sync fetching of the wasm failed";
    }
    async function getWasmBinary(binaryFile) {
      if (!wasmBinary) {
        try {
          var response = await readAsync(binaryFile);
          return new Uint8Array(response);
        } catch {}
      }
      return getBinarySync(binaryFile);
    }
    async function instantiateArrayBuffer(binaryFile, imports) {
      try {
        var binary = await getWasmBinary(binaryFile);
        var instance = await WebAssembly.instantiate(binary, imports);
        return instance;
      } catch (reason) {
        err(`failed to asynchronously prepare wasm: ${reason}`);
        if (isFileURI(wasmBinaryFile)) {
          err(
            `warning: Loading from a file URI (${wasmBinaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`,
          );
        }
        abort(reason);
      }
    }
    async function instantiateAsync(binary, binaryFile, imports) {
      if (
        !binary &&
        typeof WebAssembly.instantiateStreaming == "function" &&
        !isFileURI(binaryFile) &&
        !ENVIRONMENT_IS_NODE
      ) {
        try {
          var response = fetch(binaryFile, { credentials: "same-origin" });
          var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
          return instantiationResult;
        } catch (reason) {
          err(`wasm streaming compile failed: ${reason}`);
          err("falling back to ArrayBuffer instantiation");
        }
      }
      return instantiateArrayBuffer(binaryFile, imports);
    }
    function getWasmImports() {
      return { env: wasmImports, wasi_snapshot_preview1: wasmImports };
    }
    async function createWasm() {
      function receiveInstance(instance, module) {
        wasmExports = instance.exports;
        Module["wasmExports"] = wasmExports;
        wasmMemory = wasmExports["memory"];
        assert(wasmMemory, "memory not found in wasm exports");
        updateMemoryViews();
        wasmTable = wasmExports["__indirect_function_table"];
        assert(wasmTable, "table not found in wasm exports");
        assignWasmExports(wasmExports);
        removeRunDependency("wasm-instantiate");
        return wasmExports;
      }
      addRunDependency("wasm-instantiate");
      var trueModule = Module;
      function receiveInstantiationResult(result) {
        assert(
          Module === trueModule,
          "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?",
        );
        trueModule = null;
        return receiveInstance(result["instance"]);
      }
      var info = getWasmImports();
      if (Module["instantiateWasm"]) {
        return new Promise((resolve, reject) => {
          try {
            Module["instantiateWasm"](info, (mod, inst) => {
              resolve(receiveInstance(mod, inst));
            });
          } catch (e) {
            err(`Module.instantiateWasm callback failed with error: ${e}`);
            reject(e);
          }
        });
      }
      wasmBinaryFile ??= findWasmBinary();
      var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
      var exports$1 = receiveInstantiationResult(result);
      return exports$1;
    }
    var callRuntimeCallbacks = (callbacks) => {
      while (callbacks.length > 0) {
        callbacks.shift()(Module);
      }
    };
    var onPostRuns = [];
    var addOnPostRun = (cb) => onPostRuns.push(cb);
    var onPreRuns = [];
    var addOnPreRun = (cb) => onPreRuns.push(cb);
    var ptrToString = (ptr) => {
      assert(typeof ptr === "number");
      ptr >>>= 0;
      return "0x" + ptr.toString(16).padStart(8, "0");
    };
    var stackRestore = (val) => __emscripten_stack_restore(val);
    var stackSave = () => _emscripten_stack_get_current();
    var warnOnce = (text) => {
      warnOnce.shown ||= {};
      if (!warnOnce.shown[text]) {
        warnOnce.shown[text] = 1;
        if (ENVIRONMENT_IS_NODE) text = "warning: " + text;
        err(text);
      }
    };
    var syscallGetVarargI = () => {
      assert(SYSCALLS.varargs != undefined);
      var ret = HEAP32[+SYSCALLS.varargs >> 2];
      SYSCALLS.varargs += 4;
      return ret;
    };
    var syscallGetVarargP = syscallGetVarargI;
    var PATH = {
      isAbs: (path) => path.charAt(0) === "/",
      splitPath: (filename) => {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
      },
      normalizeArray: (parts, allowAboveRoot) => {
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
          var last = parts[i];
          if (last === ".") {
            parts.splice(i, 1);
          } else if (last === "..") {
            parts.splice(i, 1);
            up++;
          } else if (up) {
            parts.splice(i, 1);
            up--;
          }
        }
        if (allowAboveRoot) {
          for (; up; up--) {
            parts.unshift("..");
          }
        }
        return parts;
      },
      normalize: (path) => {
        var isAbsolute = PATH.isAbs(path),
          trailingSlash = path.slice(-1) === "/";
        path = PATH.normalizeArray(
          path.split("/").filter((p) => !!p),
          !isAbsolute,
        ).join("/");
        if (!path && !isAbsolute) {
          path = ".";
        }
        if (path && trailingSlash) {
          path += "/";
        }
        return (isAbsolute ? "/" : "") + path;
      },
      dirname: (path) => {
        var result = PATH.splitPath(path),
          root = result[0],
          dir = result[1];
        if (!root && !dir) {
          return ".";
        }
        if (dir) {
          dir = dir.slice(0, -1);
        }
        return root + dir;
      },
      basename: (path) => path && path.match(/([^\/]+|\/)\/*$/)[1],
      join: (...paths) => PATH.normalize(paths.join("/")),
      join2: (l, r) => PATH.normalize(l + "/" + r),
    };
    var initRandomFill = () => {
      if (ENVIRONMENT_IS_NODE) {
        var nodeCrypto = require("crypto");
        return (view) => nodeCrypto.randomFillSync(view);
      }
      return (view) => crypto.getRandomValues(view);
    };
    var randomFill = (view) => {
      (randomFill = initRandomFill())(view);
    };
    var PATH_FS = {
      resolve: (...args) => {
        var resolvedPath = "",
          resolvedAbsolute = false;
        for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
          var path = i >= 0 ? args[i] : FS.cwd();
          if (typeof path != "string") {
            throw new TypeError("Arguments to path.resolve must be strings");
          } else if (!path) {
            return "";
          }
          resolvedPath = path + "/" + resolvedPath;
          resolvedAbsolute = PATH.isAbs(path);
        }
        resolvedPath = PATH.normalizeArray(
          resolvedPath.split("/").filter((p) => !!p),
          !resolvedAbsolute,
        ).join("/");
        return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
      },
      relative: (from, to) => {
        from = PATH_FS.resolve(from).slice(1);
        to = PATH_FS.resolve(to).slice(1);
        function trim(arr) {
          var start = 0;
          for (; start < arr.length; start++) {
            if (arr[start] !== "") break;
          }
          var end = arr.length - 1;
          for (; end >= 0; end--) {
            if (arr[end] !== "") break;
          }
          if (start > end) return [];
          return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split("/"));
        var toParts = trim(to.split("/"));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
          if (fromParts[i] !== toParts[i]) {
            samePartsLength = i;
            break;
          }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
          outputParts.push("..");
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join("/");
      },
    };
    var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder() : undefined;
    var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead = NaN) => {
      var endIdx = idx + maxBytesToRead;
      var endPtr = idx;
      while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
      if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
        return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
      }
      var str = "";
      while (idx < endPtr) {
        var u0 = heapOrArray[idx++];
        if (!(u0 & 128)) {
          str += String.fromCharCode(u0);
          continue;
        }
        var u1 = heapOrArray[idx++] & 63;
        if ((u0 & 224) == 192) {
          str += String.fromCharCode(((u0 & 31) << 6) | u1);
          continue;
        }
        var u2 = heapOrArray[idx++] & 63;
        if ((u0 & 240) == 224) {
          u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
        } else {
          if ((u0 & 248) != 240)
            warnOnce(
              "Invalid UTF-8 leading byte " +
                ptrToString(u0) +
                " encountered when deserializing a UTF-8 string in wasm memory to a JS string!",
            );
          u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
        }
        if (u0 < 65536) {
          str += String.fromCharCode(u0);
        } else {
          var ch = u0 - 65536;
          str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
        }
      }
      return str;
    };
    var FS_stdin_getChar_buffer = [];
    var lengthBytesUTF8 = (str) => {
      var len = 0;
      for (var i = 0; i < str.length; ++i) {
        var c = str.charCodeAt(i);
        if (c <= 127) {
          len++;
        } else if (c <= 2047) {
          len += 2;
        } else if (c >= 55296 && c <= 57343) {
          len += 4;
          ++i;
        } else {
          len += 3;
        }
      }
      return len;
    };
    var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
      assert(typeof str === "string", `stringToUTF8Array expects a string (got ${typeof str})`);
      if (!(maxBytesToWrite > 0)) return 0;
      var startIdx = outIdx;
      var endIdx = outIdx + maxBytesToWrite - 1;
      for (var i = 0; i < str.length; ++i) {
        var u = str.codePointAt(i);
        if (u <= 127) {
          if (outIdx >= endIdx) break;
          heap[outIdx++] = u;
        } else if (u <= 2047) {
          if (outIdx + 1 >= endIdx) break;
          heap[outIdx++] = 192 | (u >> 6);
          heap[outIdx++] = 128 | (u & 63);
        } else if (u <= 65535) {
          if (outIdx + 2 >= endIdx) break;
          heap[outIdx++] = 224 | (u >> 12);
          heap[outIdx++] = 128 | ((u >> 6) & 63);
          heap[outIdx++] = 128 | (u & 63);
        } else {
          if (outIdx + 3 >= endIdx) break;
          if (u > 1114111)
            warnOnce(
              "Invalid Unicode code point " +
                ptrToString(u) +
                " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).",
            );
          heap[outIdx++] = 240 | (u >> 18);
          heap[outIdx++] = 128 | ((u >> 12) & 63);
          heap[outIdx++] = 128 | ((u >> 6) & 63);
          heap[outIdx++] = 128 | (u & 63);
          i++;
        }
      }
      heap[outIdx] = 0;
      return outIdx - startIdx;
    };
    var intArrayFromString = (stringy, dontAddNull, length) => {
      var len = lengthBytesUTF8(stringy) + 1;
      var u8array = new Array(len);
      var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
      u8array.length = numBytesWritten;
      return u8array;
    };
    var FS_stdin_getChar = () => {
      if (!FS_stdin_getChar_buffer.length) {
        var result = null;
        if (ENVIRONMENT_IS_NODE) {
          var BUFSIZE = 256;
          var buf = Buffer.alloc(BUFSIZE);
          var bytesRead = 0;
          var fd = process.stdin.fd;
          try {
            bytesRead = fs.readSync(fd, buf, 0, BUFSIZE);
          } catch (e) {
            if (e.toString().includes("EOF")) bytesRead = 0;
            else throw e;
          }
          if (bytesRead > 0) {
            result = buf.slice(0, bytesRead).toString("utf-8");
          }
        } else if (typeof window != "undefined" && typeof window.prompt == "function") {
          result = window.prompt("Input: ");
          if (result !== null) {
            result += "\n";
          }
        } else ;
        if (!result) {
          return null;
        }
        FS_stdin_getChar_buffer = intArrayFromString(result);
      }
      return FS_stdin_getChar_buffer.shift();
    };
    var TTY = {
      ttys: [],
      init() {},
      shutdown() {},
      register(dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops };
        FS.registerDevice(dev, TTY.stream_ops);
      },
      stream_ops: {
        open(stream) {
          var tty = TTY.ttys[stream.node.rdev];
          if (!tty) {
            throw new FS.ErrnoError(43);
          }
          stream.tty = tty;
          stream.seekable = false;
        },
        close(stream) {
          stream.tty.ops.fsync(stream.tty);
        },
        fsync(stream) {
          stream.tty.ops.fsync(stream.tty);
        },
        read(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.get_char) {
            throw new FS.ErrnoError(60);
          }
          var bytesRead = 0;
          for (var i = 0; i < length; i++) {
            var result;
            try {
              result = stream.tty.ops.get_char(stream.tty);
            } catch (e) {
              throw new FS.ErrnoError(29);
            }
            if (result === undefined && bytesRead === 0) {
              throw new FS.ErrnoError(6);
            }
            if (result === null || result === undefined) break;
            bytesRead++;
            buffer[offset + i] = result;
          }
          if (bytesRead) {
            stream.node.atime = Date.now();
          }
          return bytesRead;
        },
        write(stream, buffer, offset, length, pos) {
          if (!stream.tty || !stream.tty.ops.put_char) {
            throw new FS.ErrnoError(60);
          }
          try {
            for (var i = 0; i < length; i++) {
              stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
            }
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (length) {
            stream.node.mtime = stream.node.ctime = Date.now();
          }
          return i;
        },
      },
      default_tty_ops: {
        get_char(tty) {
          return FS_stdin_getChar();
        },
        put_char(tty, val) {
          if (val === null || val === 10) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        },
        fsync(tty) {
          if (tty.output?.length > 0) {
            out(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        },
        ioctl_tcgets(tty) {
          return {
            c_iflag: 25856,
            c_oflag: 5,
            c_cflag: 191,
            c_lflag: 35387,
            c_cc: [
              3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ],
          };
        },
        ioctl_tcsets(tty, optional_actions, data) {
          return 0;
        },
        ioctl_tiocgwinsz(tty) {
          return [24, 80];
        },
      },
      default_tty1_ops: {
        put_char(tty, val) {
          if (val === null || val === 10) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          } else {
            if (val != 0) tty.output.push(val);
          }
        },
        fsync(tty) {
          if (tty.output?.length > 0) {
            err(UTF8ArrayToString(tty.output));
            tty.output = [];
          }
        },
      },
    };
    var zeroMemory = (ptr, size) => HEAPU8.fill(0, ptr, ptr + size);
    var alignMemory = (size, alignment) => {
      assert(alignment, "alignment argument is required");
      return Math.ceil(size / alignment) * alignment;
    };
    var mmapAlloc = (size) => {
      size = alignMemory(size, 65536);
      var ptr = _emscripten_builtin_memalign(65536, size);
      if (ptr) zeroMemory(ptr, size);
      return ptr;
    };
    var MEMFS = {
      ops_table: null,
      mount(mount) {
        return MEMFS.createNode(null, "/", 16895, 0);
      },
      createNode(parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
          throw new FS.ErrnoError(63);
        }
        MEMFS.ops_table ||= {
          dir: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              lookup: MEMFS.node_ops.lookup,
              mknod: MEMFS.node_ops.mknod,
              rename: MEMFS.node_ops.rename,
              unlink: MEMFS.node_ops.unlink,
              rmdir: MEMFS.node_ops.rmdir,
              readdir: MEMFS.node_ops.readdir,
              symlink: MEMFS.node_ops.symlink,
            },
            stream: { llseek: MEMFS.stream_ops.llseek },
          },
          file: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
            },
            stream: {
              llseek: MEMFS.stream_ops.llseek,
              read: MEMFS.stream_ops.read,
              write: MEMFS.stream_ops.write,
              mmap: MEMFS.stream_ops.mmap,
              msync: MEMFS.stream_ops.msync,
            },
          },
          link: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
              readlink: MEMFS.node_ops.readlink,
            },
            stream: {},
          },
          chrdev: {
            node: {
              getattr: MEMFS.node_ops.getattr,
              setattr: MEMFS.node_ops.setattr,
            },
            stream: FS.chrdev_stream_ops,
          },
        };
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
          node.node_ops = MEMFS.ops_table.dir.node;
          node.stream_ops = MEMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = MEMFS.ops_table.file.node;
          node.stream_ops = MEMFS.ops_table.file.stream;
          node.usedBytes = 0;
          node.contents = null;
        } else if (FS.isLink(node.mode)) {
          node.node_ops = MEMFS.ops_table.link.node;
          node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
          node.node_ops = MEMFS.ops_table.chrdev.node;
          node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.atime = node.mtime = node.ctime = Date.now();
        if (parent) {
          parent.contents[name] = node;
          parent.atime = parent.mtime = parent.ctime = node.atime;
        }
        return node;
      },
      getFileDataAsTypedArray(node) {
        if (!node.contents) return new Uint8Array(0);
        if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
        return new Uint8Array(node.contents);
      },
      expandFileStorage(node, newCapacity) {
        var prevCapacity = node.contents ? node.contents.length : 0;
        if (prevCapacity >= newCapacity) return;
        var CAPACITY_DOUBLING_MAX = 1024 * 1024;
        newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125)) >>> 0);
        if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
        var oldContents = node.contents;
        node.contents = new Uint8Array(newCapacity);
        if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
      },
      resizeFileStorage(node, newSize) {
        if (node.usedBytes == newSize) return;
        if (newSize == 0) {
          node.contents = null;
          node.usedBytes = 0;
        } else {
          var oldContents = node.contents;
          node.contents = new Uint8Array(newSize);
          if (oldContents) {
            node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
          }
          node.usedBytes = newSize;
        }
      },
      node_ops: {
        getattr(node) {
          var attr = {};
          attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
          attr.ino = node.id;
          attr.mode = node.mode;
          attr.nlink = 1;
          attr.uid = 0;
          attr.gid = 0;
          attr.rdev = node.rdev;
          if (FS.isDir(node.mode)) {
            attr.size = 4096;
          } else if (FS.isFile(node.mode)) {
            attr.size = node.usedBytes;
          } else if (FS.isLink(node.mode)) {
            attr.size = node.link.length;
          } else {
            attr.size = 0;
          }
          attr.atime = new Date(node.atime);
          attr.mtime = new Date(node.mtime);
          attr.ctime = new Date(node.ctime);
          attr.blksize = 4096;
          attr.blocks = Math.ceil(attr.size / attr.blksize);
          return attr;
        },
        setattr(node, attr) {
          for (const key of ["mode", "atime", "mtime", "ctime"]) {
            if (attr[key] != null) {
              node[key] = attr[key];
            }
          }
          if (attr.size !== undefined) {
            MEMFS.resizeFileStorage(node, attr.size);
          }
        },
        lookup(parent, name) {
          throw new FS.ErrnoError(44);
        },
        mknod(parent, name, mode, dev) {
          return MEMFS.createNode(parent, name, mode, dev);
        },
        rename(old_node, new_dir, new_name) {
          var new_node;
          try {
            new_node = FS.lookupNode(new_dir, new_name);
          } catch (e) {}
          if (new_node) {
            if (FS.isDir(old_node.mode)) {
              for (var i in new_node.contents) {
                throw new FS.ErrnoError(55);
              }
            }
            FS.hashRemoveNode(new_node);
          }
          delete old_node.parent.contents[old_node.name];
          new_dir.contents[new_name] = old_node;
          old_node.name = new_name;
          new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
        },
        unlink(parent, name) {
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        },
        rmdir(parent, name) {
          var node = FS.lookupNode(parent, name);
          for (var i in node.contents) {
            throw new FS.ErrnoError(55);
          }
          delete parent.contents[name];
          parent.ctime = parent.mtime = Date.now();
        },
        readdir(node) {
          return [".", "..", ...Object.keys(node.contents)];
        },
        symlink(parent, newname, oldpath) {
          var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
          node.link = oldpath;
          return node;
        },
        readlink(node) {
          if (!FS.isLink(node.mode)) {
            throw new FS.ErrnoError(28);
          }
          return node.link;
        },
      },
      stream_ops: {
        read(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= stream.node.usedBytes) return 0;
          var size = Math.min(stream.node.usedBytes - position, length);
          assert(size >= 0);
          if (size > 8 && contents.subarray) {
            buffer.set(contents.subarray(position, position + size), offset);
          } else {
            for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
          }
          return size;
        },
        write(stream, buffer, offset, length, position, canOwn) {
          assert(!(buffer instanceof ArrayBuffer));
          if (buffer.buffer === HEAP8.buffer) {
            canOwn = false;
          }
          if (!length) return 0;
          var node = stream.node;
          node.mtime = node.ctime = Date.now();
          if (buffer.subarray && (!node.contents || node.contents.subarray)) {
            if (canOwn) {
              assert(position === 0, "canOwn must imply no weird position inside the file");
              node.contents = buffer.subarray(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (node.usedBytes === 0 && position === 0) {
              node.contents = buffer.slice(offset, offset + length);
              node.usedBytes = length;
              return length;
            } else if (position + length <= node.usedBytes) {
              node.contents.set(buffer.subarray(offset, offset + length), position);
              return length;
            }
          }
          MEMFS.expandFileStorage(node, position + length);
          if (node.contents.subarray && buffer.subarray) {
            node.contents.set(buffer.subarray(offset, offset + length), position);
          } else {
            for (var i = 0; i < length; i++) {
              node.contents[position + i] = buffer[offset + i];
            }
          }
          node.usedBytes = Math.max(node.usedBytes, position + length);
          return length;
        },
        llseek(stream, offset, whence) {
          var position = offset;
          if (whence === 1) {
            position += stream.position;
          } else if (whence === 2) {
            if (FS.isFile(stream.node.mode)) {
              position += stream.node.usedBytes;
            }
          }
          if (position < 0) {
            throw new FS.ErrnoError(28);
          }
          return position;
        },
        mmap(stream, length, position, prot, flags) {
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(43);
          }
          var ptr;
          var allocated;
          var contents = stream.node.contents;
          if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
            allocated = false;
            ptr = contents.byteOffset;
          } else {
            allocated = true;
            ptr = mmapAlloc(length);
            if (!ptr) {
              throw new FS.ErrnoError(48);
            }
            if (contents) {
              if (position > 0 || position + length < contents.length) {
                if (contents.subarray) {
                  contents = contents.subarray(position, position + length);
                } else {
                  contents = Array.prototype.slice.call(contents, position, position + length);
                }
              }
              HEAP8.set(contents, ptr);
            }
          }
          return { ptr, allocated };
        },
        msync(stream, buffer, offset, length, mmapFlags) {
          MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
          return 0;
        },
      },
    };
    var asyncLoad = async (url) => {
      var arrayBuffer = await readAsync(url);
      assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
      return new Uint8Array(arrayBuffer);
    };
    var FS_createDataFile = (...args) => FS.createDataFile(...args);
    var getUniqueRunDependency = (id) => {
      var orig = id;
      while (1) {
        if (!runDependencyTracking[id]) return id;
        id = orig + Math.random();
      }
    };
    var preloadPlugins = [];
    var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
      if (typeof Browser != "undefined") Browser.init();
      var handled = false;
      preloadPlugins.forEach((plugin) => {
        if (handled) return;
        if (plugin["canHandle"](fullname)) {
          plugin["handle"](byteArray, fullname, finish, onerror);
          handled = true;
        }
      });
      return handled;
    };
    var FS_createPreloadedFile = (
      parent,
      name,
      url,
      canRead,
      canWrite,
      onload,
      onerror,
      dontCreateFile,
      canOwn,
      preFinish,
    ) => {
      var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
      var dep = getUniqueRunDependency(`cp ${fullname}`);
      function processData(byteArray) {
        function finish(byteArray) {
          preFinish?.();
          if (!dontCreateFile) {
            FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
          }
          onload?.();
          removeRunDependency(dep);
        }
        if (
          FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
            onerror?.();
            removeRunDependency(dep);
          })
        ) {
          return;
        }
        finish(byteArray);
      }
      addRunDependency(dep);
      if (typeof url == "string") {
        asyncLoad(url).then(processData, onerror);
      } else {
        processData(url);
      }
    };
    var FS_modeStringToFlags = (str) => {
      var flagModes = {
        r: 0,
        "r+": 2,
        w: 512 | 64 | 1,
        "w+": 512 | 64 | 2,
        a: 1024 | 64 | 1,
        "a+": 1024 | 64 | 2,
      };
      var flags = flagModes[str];
      if (typeof flags == "undefined") {
        throw new Error(`Unknown file open mode: ${str}`);
      }
      return flags;
    };
    var FS_getMode = (canRead, canWrite) => {
      var mode = 0;
      if (canRead) mode |= 292 | 73;
      if (canWrite) mode |= 146;
      return mode;
    };
    var UTF8ToString = (ptr, maxBytesToRead) => {
      assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
      return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
    };
    var strError = (errno) => UTF8ToString(_strerror(errno));
    var ERRNO_CODES = {
      EPERM: 63,
      ENOENT: 44,
      ESRCH: 71,
      EINTR: 27,
      EIO: 29,
      ENXIO: 60,
      E2BIG: 1,
      ENOEXEC: 45,
      EBADF: 8,
      ECHILD: 12,
      EAGAIN: 6,
      EWOULDBLOCK: 6,
      ENOMEM: 48,
      EACCES: 2,
      EFAULT: 21,
      ENOTBLK: 105,
      EBUSY: 10,
      EEXIST: 20,
      EXDEV: 75,
      ENODEV: 43,
      ENOTDIR: 54,
      EISDIR: 31,
      EINVAL: 28,
      ENFILE: 41,
      EMFILE: 33,
      ENOTTY: 59,
      ETXTBSY: 74,
      EFBIG: 22,
      ENOSPC: 51,
      ESPIPE: 70,
      EROFS: 69,
      EMLINK: 34,
      EPIPE: 64,
      EDOM: 18,
      ERANGE: 68,
      ENOMSG: 49,
      EIDRM: 24,
      ECHRNG: 106,
      EL2NSYNC: 156,
      EL3HLT: 107,
      EL3RST: 108,
      ELNRNG: 109,
      EUNATCH: 110,
      ENOCSI: 111,
      EL2HLT: 112,
      EDEADLK: 16,
      ENOLCK: 46,
      EBADE: 113,
      EBADR: 114,
      EXFULL: 115,
      ENOANO: 104,
      EBADRQC: 103,
      EBADSLT: 102,
      EDEADLOCK: 16,
      EBFONT: 101,
      ENOSTR: 100,
      ENODATA: 116,
      ETIME: 117,
      ENOSR: 118,
      ENONET: 119,
      ENOPKG: 120,
      EREMOTE: 121,
      ENOLINK: 47,
      EADV: 122,
      ESRMNT: 123,
      ECOMM: 124,
      EPROTO: 65,
      EMULTIHOP: 36,
      EDOTDOT: 125,
      EBADMSG: 9,
      ENOTUNIQ: 126,
      EBADFD: 127,
      EREMCHG: 128,
      ELIBACC: 129,
      ELIBBAD: 130,
      ELIBSCN: 131,
      ELIBMAX: 132,
      ELIBEXEC: 133,
      ENOSYS: 52,
      ENOTEMPTY: 55,
      ENAMETOOLONG: 37,
      ELOOP: 32,
      EOPNOTSUPP: 138,
      EPFNOSUPPORT: 139,
      ECONNRESET: 15,
      ENOBUFS: 42,
      EAFNOSUPPORT: 5,
      EPROTOTYPE: 67,
      ENOTSOCK: 57,
      ENOPROTOOPT: 50,
      ESHUTDOWN: 140,
      ECONNREFUSED: 14,
      EADDRINUSE: 3,
      ECONNABORTED: 13,
      ENETUNREACH: 40,
      ENETDOWN: 38,
      ETIMEDOUT: 73,
      EHOSTDOWN: 142,
      EHOSTUNREACH: 23,
      EINPROGRESS: 26,
      EALREADY: 7,
      EDESTADDRREQ: 17,
      EMSGSIZE: 35,
      EPROTONOSUPPORT: 66,
      ESOCKTNOSUPPORT: 137,
      EADDRNOTAVAIL: 4,
      ENETRESET: 39,
      EISCONN: 30,
      ENOTCONN: 53,
      ETOOMANYREFS: 141,
      EUSERS: 136,
      EDQUOT: 19,
      ESTALE: 72,
      ENOTSUP: 138,
      ENOMEDIUM: 148,
      EILSEQ: 25,
      EOVERFLOW: 61,
      ECANCELED: 11,
      ENOTRECOVERABLE: 56,
      EOWNERDEAD: 62,
      ESTRPIPE: 135,
    };
    var FS = {
      root: null,
      mounts: [],
      devices: {},
      streams: [],
      nextInode: 1,
      nameTable: null,
      currentPath: "/",
      initialized: false,
      ignorePermissions: true,
      filesystems: null,
      syncFSRequests: 0,
      readFiles: {},
      ErrnoError: class extends Error {
        name = "ErrnoError";
        constructor(errno) {
          super(runtimeInitialized ? strError(errno) : "");
          this.errno = errno;
          for (var key in ERRNO_CODES) {
            if (ERRNO_CODES[key] === errno) {
              this.code = key;
              break;
            }
          }
        }
      },
      FSStream: class {
        shared = {};
        get object() {
          return this.node;
        }
        set object(val) {
          this.node = val;
        }
        get isRead() {
          return (this.flags & 2097155) !== 1;
        }
        get isWrite() {
          return (this.flags & 2097155) !== 0;
        }
        get isAppend() {
          return this.flags & 1024;
        }
        get flags() {
          return this.shared.flags;
        }
        set flags(val) {
          this.shared.flags = val;
        }
        get position() {
          return this.shared.position;
        }
        set position(val) {
          this.shared.position = val;
        }
      },
      FSNode: class {
        node_ops = {};
        stream_ops = {};
        readMode = 292 | 73;
        writeMode = 146;
        mounted = null;
        constructor(parent, name, mode, rdev) {
          if (!parent) {
            parent = this;
          }
          this.parent = parent;
          this.mount = parent.mount;
          this.id = FS.nextInode++;
          this.name = name;
          this.mode = mode;
          this.rdev = rdev;
          this.atime = this.mtime = this.ctime = Date.now();
        }
        get read() {
          return (this.mode & this.readMode) === this.readMode;
        }
        set read(val) {
          val ? (this.mode |= this.readMode) : (this.mode &= ~this.readMode);
        }
        get write() {
          return (this.mode & this.writeMode) === this.writeMode;
        }
        set write(val) {
          val ? (this.mode |= this.writeMode) : (this.mode &= ~this.writeMode);
        }
        get isFolder() {
          return FS.isDir(this.mode);
        }
        get isDevice() {
          return FS.isChrdev(this.mode);
        }
      },
      lookupPath(path, opts = {}) {
        if (!path) {
          throw new FS.ErrnoError(44);
        }
        opts.follow_mount ??= true;
        if (!PATH.isAbs(path)) {
          path = FS.cwd() + "/" + path;
        }
        linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
          var parts = path.split("/").filter((p) => !!p);
          var current = FS.root;
          var current_path = "/";
          for (var i = 0; i < parts.length; i++) {
            var islast = i === parts.length - 1;
            if (islast && opts.parent) {
              break;
            }
            if (parts[i] === ".") {
              continue;
            }
            if (parts[i] === "..") {
              current_path = PATH.dirname(current_path);
              if (FS.isRoot(current)) {
                path = current_path + "/" + parts.slice(i + 1).join("/");
                continue linkloop;
              } else {
                current = current.parent;
              }
              continue;
            }
            current_path = PATH.join2(current_path, parts[i]);
            try {
              current = FS.lookupNode(current, parts[i]);
            } catch (e) {
              if (e?.errno === 44 && islast && opts.noent_okay) {
                return { path: current_path };
              }
              throw e;
            }
            if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
              current = current.mounted.root;
            }
            if (FS.isLink(current.mode) && (!islast || opts.follow)) {
              if (!current.node_ops.readlink) {
                throw new FS.ErrnoError(52);
              }
              var link = current.node_ops.readlink(current);
              if (!PATH.isAbs(link)) {
                link = PATH.dirname(current_path) + "/" + link;
              }
              path = link + "/" + parts.slice(i + 1).join("/");
              continue linkloop;
            }
          }
          return { path: current_path, node: current };
        }
        throw new FS.ErrnoError(32);
      },
      getPath(node) {
        var path;
        while (true) {
          if (FS.isRoot(node)) {
            var mount = node.mount.mountpoint;
            if (!path) return mount;
            return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
          }
          path = path ? `${node.name}/${path}` : node.name;
          node = node.parent;
        }
      },
      hashName(parentid, name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
      },
      hashAddNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
      },
      hashRemoveNode(node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
          FS.nameTable[hash] = node.name_next;
        } else {
          var current = FS.nameTable[hash];
          while (current) {
            if (current.name_next === node) {
              current.name_next = node.name_next;
              break;
            }
            current = current.name_next;
          }
        }
      },
      lookupNode(parent, name) {
        var errCode = FS.mayLookup(parent);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
          var nodeName = node.name;
          if (node.parent.id === parent.id && nodeName === name) {
            return node;
          }
        }
        return FS.lookup(parent, name);
      },
      createNode(parent, name, mode, rdev) {
        assert(typeof parent == "object");
        var node = new FS.FSNode(parent, name, mode, rdev);
        FS.hashAddNode(node);
        return node;
      },
      destroyNode(node) {
        FS.hashRemoveNode(node);
      },
      isRoot(node) {
        return node === node.parent;
      },
      isMountpoint(node) {
        return !!node.mounted;
      },
      isFile(mode) {
        return (mode & 61440) === 32768;
      },
      isDir(mode) {
        return (mode & 61440) === 16384;
      },
      isLink(mode) {
        return (mode & 61440) === 40960;
      },
      isChrdev(mode) {
        return (mode & 61440) === 8192;
      },
      isBlkdev(mode) {
        return (mode & 61440) === 24576;
      },
      isFIFO(mode) {
        return (mode & 61440) === 4096;
      },
      isSocket(mode) {
        return (mode & 49152) === 49152;
      },
      flagsToPermissionString(flag) {
        var perms = ["r", "w", "rw"][flag & 3];
        if (flag & 512) {
          perms += "w";
        }
        return perms;
      },
      nodePermissions(node, perms) {
        if (FS.ignorePermissions) {
          return 0;
        }
        if (perms.includes("r") && !(node.mode & 292)) {
          return 2;
        } else if (perms.includes("w") && !(node.mode & 146)) {
          return 2;
        } else if (perms.includes("x") && !(node.mode & 73)) {
          return 2;
        }
        return 0;
      },
      mayLookup(dir) {
        if (!FS.isDir(dir.mode)) return 54;
        var errCode = FS.nodePermissions(dir, "x");
        if (errCode) return errCode;
        if (!dir.node_ops.lookup) return 2;
        return 0;
      },
      mayCreate(dir, name) {
        if (!FS.isDir(dir.mode)) {
          return 54;
        }
        try {
          var node = FS.lookupNode(dir, name);
          return 20;
        } catch (e) {}
        return FS.nodePermissions(dir, "wx");
      },
      mayDelete(dir, name, isdir) {
        var node;
        try {
          node = FS.lookupNode(dir, name);
        } catch (e) {
          return e.errno;
        }
        var errCode = FS.nodePermissions(dir, "wx");
        if (errCode) {
          return errCode;
        }
        if (isdir) {
          if (!FS.isDir(node.mode)) {
            return 54;
          }
          if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
            return 10;
          }
        } else {
          if (FS.isDir(node.mode)) {
            return 31;
          }
        }
        return 0;
      },
      mayOpen(node, flags) {
        if (!node) {
          return 44;
        }
        if (FS.isLink(node.mode)) {
          return 32;
        } else if (FS.isDir(node.mode)) {
          if (FS.flagsToPermissionString(flags) !== "r" || flags & (512 | 64)) {
            return 31;
          }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
      },
      checkOpExists(op, err) {
        if (!op) {
          throw new FS.ErrnoError(err);
        }
        return op;
      },
      MAX_OPEN_FDS: 4096,
      nextfd() {
        for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
          if (!FS.streams[fd]) {
            return fd;
          }
        }
        throw new FS.ErrnoError(33);
      },
      getStreamChecked(fd) {
        var stream = FS.getStream(fd);
        if (!stream) {
          throw new FS.ErrnoError(8);
        }
        return stream;
      },
      getStream: (fd) => FS.streams[fd],
      createStream(stream, fd = -1) {
        assert(fd >= -1);
        stream = Object.assign(new FS.FSStream(), stream);
        if (fd == -1) {
          fd = FS.nextfd();
        }
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
      },
      closeStream(fd) {
        FS.streams[fd] = null;
      },
      dupStream(origStream, fd = -1) {
        var stream = FS.createStream(origStream, fd);
        stream.stream_ops?.dup?.(stream);
        return stream;
      },
      doSetAttr(stream, node, attr) {
        var setattr = stream?.stream_ops.setattr;
        var arg = setattr ? stream : node;
        setattr ??= node.node_ops.setattr;
        FS.checkOpExists(setattr, 63);
        setattr(arg, attr);
      },
      chrdev_stream_ops: {
        open(stream) {
          var device = FS.getDevice(stream.node.rdev);
          stream.stream_ops = device.stream_ops;
          stream.stream_ops.open?.(stream);
        },
        llseek() {
          throw new FS.ErrnoError(70);
        },
      },
      major: (dev) => dev >> 8,
      minor: (dev) => dev & 255,
      makedev: (ma, mi) => (ma << 8) | mi,
      registerDevice(dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
      },
      getDevice: (dev) => FS.devices[dev],
      getMounts(mount) {
        var mounts = [];
        var check = [mount];
        while (check.length) {
          var m = check.pop();
          mounts.push(m);
          check.push(...m.mounts);
        }
        return mounts;
      },
      syncfs(populate, callback) {
        if (typeof populate == "function") {
          callback = populate;
          populate = false;
        }
        FS.syncFSRequests++;
        if (FS.syncFSRequests > 1) {
          err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
        }
        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;
        function doCallback(errCode) {
          assert(FS.syncFSRequests > 0);
          FS.syncFSRequests--;
          return callback(errCode);
        }
        function done(errCode) {
          if (errCode) {
            if (!done.errored) {
              done.errored = true;
              return doCallback(errCode);
            }
            return;
          }
          if (++completed >= mounts.length) {
            doCallback(null);
          }
        }
        mounts.forEach((mount) => {
          if (!mount.type.syncfs) {
            return done(null);
          }
          mount.type.syncfs(mount, populate, done);
        });
      },
      mount(type, opts, mountpoint) {
        if (typeof type == "string") {
          throw type;
        }
        var root = mountpoint === "/";
        var pseudo = !mountpoint;
        var node;
        if (root && FS.root) {
          throw new FS.ErrnoError(10);
        } else if (!root && !pseudo) {
          var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
          mountpoint = lookup.path;
          node = lookup.node;
          if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(10);
          }
          if (!FS.isDir(node.mode)) {
            throw new FS.ErrnoError(54);
          }
        }
        var mount = { type, opts, mountpoint, mounts: [] };
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;
        if (root) {
          FS.root = mountRoot;
        } else if (node) {
          node.mounted = mount;
          if (node.mount) {
            node.mount.mounts.push(mount);
          }
        }
        return mountRoot;
      },
      unmount(mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });
        if (!FS.isMountpoint(lookup.node)) {
          throw new FS.ErrnoError(28);
        }
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);
        Object.keys(FS.nameTable).forEach((hash) => {
          var current = FS.nameTable[hash];
          while (current) {
            var next = current.name_next;
            if (mounts.includes(current.mount)) {
              FS.destroyNode(current);
            }
            current = next;
          }
        });
        node.mounted = null;
        var idx = node.mount.mounts.indexOf(mount);
        assert(idx !== -1);
        node.mount.mounts.splice(idx, 1);
      },
      lookup(parent, name) {
        return parent.node_ops.lookup(parent, name);
      },
      mknod(path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        if (!name) {
          throw new FS.ErrnoError(28);
        }
        if (name === "." || name === "..") {
          throw new FS.ErrnoError(20);
        }
        var errCode = FS.mayCreate(parent, name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.mknod) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
      },
      statfs(path) {
        return FS.statfsNode(FS.lookupPath(path, { follow: true }).node);
      },
      statfsStream(stream) {
        return FS.statfsNode(stream.node);
      },
      statfsNode(node) {
        var rtn = {
          bsize: 4096,
          frsize: 4096,
          blocks: 1e6,
          bfree: 5e5,
          bavail: 5e5,
          files: FS.nextInode,
          ffree: FS.nextInode - 1,
          fsid: 42,
          flags: 2,
          namelen: 255,
        };
        if (node.node_ops.statfs) {
          Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
        }
        return rtn;
      },
      create(path, mode = 438) {
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
      },
      mkdir(path, mode = 511) {
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
      },
      mkdirTree(path, mode) {
        var dirs = path.split("/");
        var d = "";
        for (var dir of dirs) {
          if (!dir) continue;
          if (d || PATH.isAbs(path)) d += "/";
          d += dir;
          try {
            FS.mkdir(d, mode);
          } catch (e) {
            if (e.errno != 20) throw e;
          }
        }
      },
      mkdev(path, mode, dev) {
        if (typeof dev == "undefined") {
          dev = mode;
          mode = 438;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
      },
      symlink(oldpath, newpath) {
        if (!PATH_FS.resolve(oldpath)) {
          throw new FS.ErrnoError(44);
        }
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var newname = PATH.basename(newpath);
        var errCode = FS.mayCreate(parent, newname);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.symlink) {
          throw new FS.ErrnoError(63);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
      },
      rename(old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        var lookup, old_dir, new_dir;
        lookup = FS.lookupPath(old_path, { parent: true });
        old_dir = lookup.node;
        lookup = FS.lookupPath(new_path, { parent: true });
        new_dir = lookup.node;
        if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
        if (old_dir.mount !== new_dir.mount) {
          throw new FS.ErrnoError(75);
        }
        var old_node = FS.lookupNode(old_dir, old_name);
        var relative = PATH_FS.relative(old_path, new_dirname);
        if (relative.charAt(0) !== ".") {
          throw new FS.ErrnoError(28);
        }
        relative = PATH_FS.relative(new_path, old_dirname);
        if (relative.charAt(0) !== ".") {
          throw new FS.ErrnoError(55);
        }
        var new_node;
        try {
          new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {}
        if (old_node === new_node) {
          return;
        }
        var isdir = FS.isDir(old_node.mode);
        var errCode = FS.mayDelete(old_dir, old_name, isdir);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!old_dir.node_ops.rename) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
          throw new FS.ErrnoError(10);
        }
        if (new_dir !== old_dir) {
          errCode = FS.nodePermissions(old_dir, "w");
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        FS.hashRemoveNode(old_node);
        try {
          old_dir.node_ops.rename(old_node, new_dir, new_name);
          old_node.parent = new_dir;
        } catch (e) {
          throw e;
        } finally {
          FS.hashAddNode(old_node);
        }
      },
      rmdir(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, true);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.rmdir) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
      },
      readdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
        return readdir(node);
      },
      unlink(path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        if (!parent) {
          throw new FS.ErrnoError(44);
        }
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var errCode = FS.mayDelete(parent, name, false);
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        if (!parent.node_ops.unlink) {
          throw new FS.ErrnoError(63);
        }
        if (FS.isMountpoint(node)) {
          throw new FS.ErrnoError(10);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
      },
      readlink(path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link) {
          throw new FS.ErrnoError(44);
        }
        if (!link.node_ops.readlink) {
          throw new FS.ErrnoError(28);
        }
        return link.node_ops.readlink(link);
      },
      stat(path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
        return getattr(node);
      },
      fstat(fd) {
        var stream = FS.getStreamChecked(fd);
        var node = stream.node;
        var getattr = stream.stream_ops.getattr;
        var arg = getattr ? stream : node;
        getattr ??= node.node_ops.getattr;
        FS.checkOpExists(getattr, 63);
        return getattr(arg);
      },
      lstat(path) {
        return FS.stat(path, true);
      },
      doChmod(stream, node, mode, dontFollow) {
        FS.doSetAttr(stream, node, {
          mode: (mode & 4095) | (node.mode & -4096),
          ctime: Date.now(),
          dontFollow,
        });
      },
      chmod(path, mode, dontFollow) {
        var node;
        if (typeof path == "string") {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doChmod(null, node, mode, dontFollow);
      },
      lchmod(path, mode) {
        FS.chmod(path, mode, true);
      },
      fchmod(fd, mode) {
        var stream = FS.getStreamChecked(fd);
        FS.doChmod(stream, stream.node, mode, false);
      },
      doChown(stream, node, dontFollow) {
        FS.doSetAttr(stream, node, { timestamp: Date.now(), dontFollow });
      },
      chown(path, uid, gid, dontFollow) {
        var node;
        if (typeof path == "string") {
          var lookup = FS.lookupPath(path, { follow: !dontFollow });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doChown(null, node, dontFollow);
      },
      lchown(path, uid, gid) {
        FS.chown(path, uid, gid, true);
      },
      fchown(fd, uid, gid) {
        var stream = FS.getStreamChecked(fd);
        FS.doChown(stream, stream.node, false);
      },
      doTruncate(stream, node, len) {
        if (FS.isDir(node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!FS.isFile(node.mode)) {
          throw new FS.ErrnoError(28);
        }
        var errCode = FS.nodePermissions(node, "w");
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        FS.doSetAttr(stream, node, { size: len, timestamp: Date.now() });
      },
      truncate(path, len) {
        if (len < 0) {
          throw new FS.ErrnoError(28);
        }
        var node;
        if (typeof path == "string") {
          var lookup = FS.lookupPath(path, { follow: true });
          node = lookup.node;
        } else {
          node = path;
        }
        FS.doTruncate(null, node, len);
      },
      ftruncate(fd, len) {
        var stream = FS.getStreamChecked(fd);
        if (len < 0 || (stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(28);
        }
        FS.doTruncate(stream, stream.node, len);
      },
      utime(path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
        setattr(node, { atime, mtime });
      },
      open(path, flags, mode = 438) {
        if (path === "") {
          throw new FS.ErrnoError(44);
        }
        flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
        if (flags & 64) {
          mode = (mode & 4095) | 32768;
        } else {
          mode = 0;
        }
        var node;
        var isDirPath;
        if (typeof path == "object") {
          node = path;
        } else {
          isDirPath = path.endsWith("/");
          var lookup = FS.lookupPath(path, {
            follow: !(flags & 131072),
            noent_okay: true,
          });
          node = lookup.node;
          path = lookup.path;
        }
        var created = false;
        if (flags & 64) {
          if (node) {
            if (flags & 128) {
              throw new FS.ErrnoError(20);
            }
          } else if (isDirPath) {
            throw new FS.ErrnoError(31);
          } else {
            node = FS.mknod(path, mode | 511, 0);
            created = true;
          }
        }
        if (!node) {
          throw new FS.ErrnoError(44);
        }
        if (FS.isChrdev(node.mode)) {
          flags &= -513;
        }
        if (flags & 65536 && !FS.isDir(node.mode)) {
          throw new FS.ErrnoError(54);
        }
        if (!created) {
          var errCode = FS.mayOpen(node, flags);
          if (errCode) {
            throw new FS.ErrnoError(errCode);
          }
        }
        if (flags & 512 && !created) {
          FS.truncate(node, 0);
        }
        flags &= -131713;
        var stream = FS.createStream({
          node,
          path: FS.getPath(node),
          flags,
          seekable: true,
          position: 0,
          stream_ops: node.stream_ops,
          ungotten: [],
          error: false,
        });
        if (stream.stream_ops.open) {
          stream.stream_ops.open(stream);
        }
        if (created) {
          FS.chmod(node, mode & 511);
        }
        if (Module["logReadFiles"] && !(flags & 1)) {
          if (!(path in FS.readFiles)) {
            FS.readFiles[path] = 1;
          }
        }
        return stream;
      },
      close(stream) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (stream.getdents) stream.getdents = null;
        try {
          if (stream.stream_ops.close) {
            stream.stream_ops.close(stream);
          }
        } catch (e) {
          throw e;
        } finally {
          FS.closeStream(stream.fd);
        }
        stream.fd = null;
      },
      isClosed(stream) {
        return stream.fd === null;
      },
      llseek(stream, offset, whence) {
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if (!stream.seekable || !stream.stream_ops.llseek) {
          throw new FS.ErrnoError(70);
        }
        if (whence != 0 && whence != 1 && whence != 2) {
          throw new FS.ErrnoError(28);
        }
        stream.position = stream.stream_ops.llseek(stream, offset, whence);
        stream.ungotten = [];
        return stream.position;
      },
      read(stream, buffer, offset, length, position) {
        assert(offset >= 0);
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.read) {
          throw new FS.ErrnoError(28);
        }
        var seeking = typeof position != "undefined";
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
      },
      write(stream, buffer, offset, length, position, canOwn) {
        assert(offset >= 0);
        if (length < 0 || position < 0) {
          throw new FS.ErrnoError(28);
        }
        if (FS.isClosed(stream)) {
          throw new FS.ErrnoError(8);
        }
        if ((stream.flags & 2097155) === 0) {
          throw new FS.ErrnoError(8);
        }
        if (FS.isDir(stream.node.mode)) {
          throw new FS.ErrnoError(31);
        }
        if (!stream.stream_ops.write) {
          throw new FS.ErrnoError(28);
        }
        if (stream.seekable && stream.flags & 1024) {
          FS.llseek(stream, 0, 2);
        }
        var seeking = typeof position != "undefined";
        if (!seeking) {
          position = stream.position;
        } else if (!stream.seekable) {
          throw new FS.ErrnoError(70);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
      },
      mmap(stream, length, position, prot, flags) {
        if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
          throw new FS.ErrnoError(2);
        }
        if ((stream.flags & 2097155) === 1) {
          throw new FS.ErrnoError(2);
        }
        if (!stream.stream_ops.mmap) {
          throw new FS.ErrnoError(43);
        }
        if (!length) {
          throw new FS.ErrnoError(28);
        }
        return stream.stream_ops.mmap(stream, length, position, prot, flags);
      },
      msync(stream, buffer, offset, length, mmapFlags) {
        assert(offset >= 0);
        if (!stream.stream_ops.msync) {
          return 0;
        }
        return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
      },
      ioctl(stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
          throw new FS.ErrnoError(59);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
      },
      readFile(path, opts = {}) {
        opts.flags = opts.flags || 0;
        opts.encoding = opts.encoding || "binary";
        if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
          throw new Error(`Invalid encoding type "${opts.encoding}"`);
        }
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === "utf8") {
          buf = UTF8ArrayToString(buf);
        }
        FS.close(stream);
        return buf;
      },
      writeFile(path, data, opts = {}) {
        opts.flags = opts.flags || 577;
        var stream = FS.open(path, opts.flags, opts.mode);
        if (typeof data == "string") {
          data = new Uint8Array(intArrayFromString(data));
        }
        if (ArrayBuffer.isView(data)) {
          FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
        } else {
          throw new Error("Unsupported data type");
        }
        FS.close(stream);
      },
      cwd: () => FS.currentPath,
      chdir(path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (lookup.node === null) {
          throw new FS.ErrnoError(44);
        }
        if (!FS.isDir(lookup.node.mode)) {
          throw new FS.ErrnoError(54);
        }
        var errCode = FS.nodePermissions(lookup.node, "x");
        if (errCode) {
          throw new FS.ErrnoError(errCode);
        }
        FS.currentPath = lookup.path;
      },
      createDefaultDirectories() {
        FS.mkdir("/tmp");
        FS.mkdir("/home");
        FS.mkdir("/home/web_user");
      },
      createDefaultDevices() {
        FS.mkdir("/dev");
        FS.registerDevice(FS.makedev(1, 3), {
          read: () => 0,
          write: (stream, buffer, offset, length, pos) => length,
          llseek: () => 0,
        });
        FS.mkdev("/dev/null", FS.makedev(1, 3));
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev("/dev/tty", FS.makedev(5, 0));
        FS.mkdev("/dev/tty1", FS.makedev(6, 0));
        var randomBuffer = new Uint8Array(1024),
          randomLeft = 0;
        var randomByte = () => {
          if (randomLeft === 0) {
            randomFill(randomBuffer);
            randomLeft = randomBuffer.byteLength;
          }
          return randomBuffer[--randomLeft];
        };
        FS.createDevice("/dev", "random", randomByte);
        FS.createDevice("/dev", "urandom", randomByte);
        FS.mkdir("/dev/shm");
        FS.mkdir("/dev/shm/tmp");
      },
      createSpecialDirectories() {
        FS.mkdir("/proc");
        var proc_self = FS.mkdir("/proc/self");
        FS.mkdir("/proc/self/fd");
        FS.mount(
          {
            mount() {
              var node = FS.createNode(proc_self, "fd", 16895, 73);
              node.stream_ops = { llseek: MEMFS.stream_ops.llseek };
              node.node_ops = {
                lookup(parent, name) {
                  var fd = +name;
                  var stream = FS.getStreamChecked(fd);
                  var ret = {
                    parent: null,
                    mount: { mountpoint: "fake" },
                    node_ops: { readlink: () => stream.path },
                    id: fd + 1,
                  };
                  ret.parent = ret;
                  return ret;
                },
                readdir() {
                  return Array.from(FS.streams.entries())
                    .filter(([k, v]) => v)
                    .map(([k, v]) => k.toString());
                },
              };
              return node;
            },
          },
          {},
          "/proc/self/fd",
        );
      },
      createStandardStreams(input, output, error) {
        if (input) {
          FS.createDevice("/dev", "stdin", input);
        } else {
          FS.symlink("/dev/tty", "/dev/stdin");
        }
        if (output) {
          FS.createDevice("/dev", "stdout", null, output);
        } else {
          FS.symlink("/dev/tty", "/dev/stdout");
        }
        if (error) {
          FS.createDevice("/dev", "stderr", null, error);
        } else {
          FS.symlink("/dev/tty1", "/dev/stderr");
        }
        var stdin = FS.open("/dev/stdin", 0);
        var stdout = FS.open("/dev/stdout", 1);
        var stderr = FS.open("/dev/stderr", 1);
        assert(stdin.fd === 0, `invalid handle for stdin (${stdin.fd})`);
        assert(stdout.fd === 1, `invalid handle for stdout (${stdout.fd})`);
        assert(stderr.fd === 2, `invalid handle for stderr (${stderr.fd})`);
      },
      staticInit() {
        FS.nameTable = new Array(4096);
        FS.mount(MEMFS, {}, "/");
        FS.createDefaultDirectories();
        FS.createDefaultDevices();
        FS.createSpecialDirectories();
        FS.filesystems = { MEMFS };
      },
      init(input, output, error) {
        assert(
          !FS.initialized,
          "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)",
        );
        FS.initialized = true;
        input ??= Module["stdin"];
        output ??= Module["stdout"];
        error ??= Module["stderr"];
        FS.createStandardStreams(input, output, error);
      },
      quit() {
        FS.initialized = false;
        _fflush(0);
        for (var stream of FS.streams) {
          if (stream) {
            FS.close(stream);
          }
        }
      },
      findObject(path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (!ret.exists) {
          return null;
        }
        return ret.object;
      },
      analyzePath(path, dontResolveLastLink) {
        try {
          var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          path = lookup.path;
        } catch (e) {}
        var ret = {
          isRoot: false,
          exists: false,
          error: 0,
          name: null,
          path: null,
          object: null,
          parentExists: false,
          parentPath: null,
          parentObject: null,
        };
        try {
          var lookup = FS.lookupPath(path, { parent: true });
          ret.parentExists = true;
          ret.parentPath = lookup.path;
          ret.parentObject = lookup.node;
          ret.name = PATH.basename(path);
          lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
          ret.exists = true;
          ret.path = lookup.path;
          ret.object = lookup.node;
          ret.name = lookup.node.name;
          ret.isRoot = lookup.path === "/";
        } catch (e) {
          ret.error = e.errno;
        }
        return ret;
      },
      createPath(parent, path, canRead, canWrite) {
        parent = typeof parent == "string" ? parent : FS.getPath(parent);
        var parts = path.split("/").reverse();
        while (parts.length) {
          var part = parts.pop();
          if (!part) continue;
          var current = PATH.join2(parent, part);
          try {
            FS.mkdir(current);
          } catch (e) {
            if (e.errno != 20) throw e;
          }
          parent = current;
        }
        return current;
      },
      createFile(parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(canRead, canWrite);
        return FS.create(path, mode);
      },
      createDataFile(parent, name, data, canRead, canWrite, canOwn) {
        var path = name;
        if (parent) {
          parent = typeof parent == "string" ? parent : FS.getPath(parent);
          path = name ? PATH.join2(parent, name) : parent;
        }
        var mode = FS_getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
          if (typeof data == "string") {
            var arr = new Array(data.length);
            for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
            data = arr;
          }
          FS.chmod(node, mode | 146);
          var stream = FS.open(node, 577);
          FS.write(stream, data, 0, data.length, 0, canOwn);
          FS.close(stream);
          FS.chmod(node, mode);
        }
      },
      createDevice(parent, name, input, output) {
        var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
        var mode = FS_getMode(!!input, !!output);
        FS.createDevice.major ??= 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        FS.registerDevice(dev, {
          open(stream) {
            stream.seekable = false;
          },
          close(stream) {
            if (output?.buffer?.length) {
              output(10);
            }
          },
          read(stream, buffer, offset, length, pos) {
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
              var result;
              try {
                result = input();
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
              if (result === undefined && bytesRead === 0) {
                throw new FS.ErrnoError(6);
              }
              if (result === null || result === undefined) break;
              bytesRead++;
              buffer[offset + i] = result;
            }
            if (bytesRead) {
              stream.node.atime = Date.now();
            }
            return bytesRead;
          },
          write(stream, buffer, offset, length, pos) {
            for (var i = 0; i < length; i++) {
              try {
                output(buffer[offset + i]);
              } catch (e) {
                throw new FS.ErrnoError(29);
              }
            }
            if (length) {
              stream.node.mtime = stream.node.ctime = Date.now();
            }
            return i;
          },
        });
        return FS.mkdev(path, mode, dev);
      },
      forceLoadFile(obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        if (typeof XMLHttpRequest != "undefined") {
          throw new Error(
            "Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.",
          );
        } else {
          try {
            obj.contents = readBinary(obj.url);
            obj.usedBytes = obj.contents.length;
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
        }
      },
      createLazyFile(parent, name, url, canRead, canWrite) {
        class LazyUint8Array {
          lengthKnown = false;
          chunks = [];
          get(idx) {
            if (idx > this.length - 1 || idx < 0) {
              return undefined;
            }
            var chunkOffset = idx % this.chunkSize;
            var chunkNum = (idx / this.chunkSize) | 0;
            return this.getter(chunkNum)[chunkOffset];
          }
          setDataGetter(getter) {
            this.getter = getter;
          }
          cacheLength() {
            var xhr = new XMLHttpRequest();
            xhr.open("HEAD", url, false);
            xhr.send(null);
            if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
              throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
            var datalength = Number(xhr.getResponseHeader("Content-length"));
            var header;
            var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
            var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
            var chunkSize = 1024 * 1024;
            if (!hasByteServing) chunkSize = datalength;
            var doXHR = (from, to) => {
              if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
              if (to > datalength - 1) throw new Error("only " + datalength + " bytes available! programmer error!");
              var xhr = new XMLHttpRequest();
              xhr.open("GET", url, false);
              if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
              xhr.responseType = "arraybuffer";
              if (xhr.overrideMimeType) {
                xhr.overrideMimeType("text/plain; charset=x-user-defined");
              }
              xhr.send(null);
              if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
                throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
              if (xhr.response !== undefined) {
                return new Uint8Array(xhr.response || []);
              }
              return intArrayFromString(xhr.responseText || "");
            };
            var lazyArray = this;
            lazyArray.setDataGetter((chunkNum) => {
              var start = chunkNum * chunkSize;
              var end = (chunkNum + 1) * chunkSize - 1;
              end = Math.min(end, datalength - 1);
              if (typeof lazyArray.chunks[chunkNum] == "undefined") {
                lazyArray.chunks[chunkNum] = doXHR(start, end);
              }
              if (typeof lazyArray.chunks[chunkNum] == "undefined") throw new Error("doXHR failed!");
              return lazyArray.chunks[chunkNum];
            });
            if (usesGzip || !datalength) {
              chunkSize = datalength = 1;
              datalength = this.getter(0).length;
              chunkSize = datalength;
              out("LazyFiles on gzip forces download of the whole file when length is accessed");
            }
            this._length = datalength;
            this._chunkSize = chunkSize;
            this.lengthKnown = true;
          }
          get length() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._length;
          }
          get chunkSize() {
            if (!this.lengthKnown) {
              this.cacheLength();
            }
            return this._chunkSize;
          }
        }
        if (typeof XMLHttpRequest != "undefined") {
          if (!ENVIRONMENT_IS_WORKER)
            throw "Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc";
          var lazyArray = new LazyUint8Array();
          var properties = { isDevice: false, contents: lazyArray };
        } else {
          var properties = { isDevice: false, url };
        }
        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        if (properties.contents) {
          node.contents = properties.contents;
        } else if (properties.url) {
          node.contents = null;
          node.url = properties.url;
        }
        Object.defineProperties(node, {
          usedBytes: {
            get: function () {
              return this.contents.length;
            },
          },
        });
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach((key) => {
          var fn = node.stream_ops[key];
          stream_ops[key] = (...args) => {
            FS.forceLoadFile(node);
            return fn(...args);
          };
        });
        function writeChunks(stream, buffer, offset, length, position) {
          var contents = stream.node.contents;
          if (position >= contents.length) return 0;
          var size = Math.min(contents.length - position, length);
          assert(size >= 0);
          if (contents.slice) {
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents[position + i];
            }
          } else {
            for (var i = 0; i < size; i++) {
              buffer[offset + i] = contents.get(position + i);
            }
          }
          return size;
        }
        stream_ops.read = (stream, buffer, offset, length, position) => {
          FS.forceLoadFile(node);
          return writeChunks(stream, buffer, offset, length, position);
        };
        stream_ops.mmap = (stream, length, position, prot, flags) => {
          FS.forceLoadFile(node);
          var ptr = mmapAlloc(length);
          if (!ptr) {
            throw new FS.ErrnoError(48);
          }
          writeChunks(stream, HEAP8, ptr, length, position);
          return { ptr, allocated: true };
        };
        node.stream_ops = stream_ops;
        return node;
      },
      absolutePath() {
        abort("FS.absolutePath has been removed; use PATH_FS.resolve instead");
      },
      createFolder() {
        abort("FS.createFolder has been removed; use FS.mkdir instead");
      },
      createLink() {
        abort("FS.createLink has been removed; use FS.symlink instead");
      },
      joinPath() {
        abort("FS.joinPath has been removed; use PATH.join instead");
      },
      mmapAlloc() {
        abort("FS.mmapAlloc has been replaced by the top level function mmapAlloc");
      },
      standardizePath() {
        abort("FS.standardizePath has been removed; use PATH.normalize instead");
      },
    };
    var SYSCALLS = {
      DEFAULT_POLLMASK: 5,
      calculateAt(dirfd, path, allowEmpty) {
        if (PATH.isAbs(path)) {
          return path;
        }
        var dir;
        if (dirfd === -100) {
          dir = FS.cwd();
        } else {
          var dirstream = SYSCALLS.getStreamFromFD(dirfd);
          dir = dirstream.path;
        }
        if (path.length == 0) {
          if (!allowEmpty) {
            throw new FS.ErrnoError(44);
          }
          return dir;
        }
        return dir + "/" + path;
      },
      writeStat(buf, stat) {
        HEAP32[buf >> 2] = stat.dev;
        HEAP32[(buf + 4) >> 2] = stat.mode;
        HEAPU32[(buf + 8) >> 2] = stat.nlink;
        HEAP32[(buf + 12) >> 2] = stat.uid;
        HEAP32[(buf + 16) >> 2] = stat.gid;
        HEAP32[(buf + 20) >> 2] = stat.rdev;
        HEAP64[(buf + 24) >> 3] = BigInt(stat.size);
        HEAP32[(buf + 32) >> 2] = 4096;
        HEAP32[(buf + 36) >> 2] = stat.blocks;
        var atime = stat.atime.getTime();
        var mtime = stat.mtime.getTime();
        var ctime = stat.ctime.getTime();
        HEAP64[(buf + 40) >> 3] = BigInt(Math.floor(atime / 1e3));
        HEAPU32[(buf + 48) >> 2] = (atime % 1e3) * 1e3 * 1e3;
        HEAP64[(buf + 56) >> 3] = BigInt(Math.floor(mtime / 1e3));
        HEAPU32[(buf + 64) >> 2] = (mtime % 1e3) * 1e3 * 1e3;
        HEAP64[(buf + 72) >> 3] = BigInt(Math.floor(ctime / 1e3));
        HEAPU32[(buf + 80) >> 2] = (ctime % 1e3) * 1e3 * 1e3;
        HEAP64[(buf + 88) >> 3] = BigInt(stat.ino);
        return 0;
      },
      writeStatFs(buf, stats) {
        HEAP32[(buf + 4) >> 2] = stats.bsize;
        HEAP32[(buf + 40) >> 2] = stats.bsize;
        HEAP32[(buf + 8) >> 2] = stats.blocks;
        HEAP32[(buf + 12) >> 2] = stats.bfree;
        HEAP32[(buf + 16) >> 2] = stats.bavail;
        HEAP32[(buf + 20) >> 2] = stats.files;
        HEAP32[(buf + 24) >> 2] = stats.ffree;
        HEAP32[(buf + 28) >> 2] = stats.fsid;
        HEAP32[(buf + 44) >> 2] = stats.flags;
        HEAP32[(buf + 36) >> 2] = stats.namelen;
      },
      doMsync(addr, stream, len, flags, offset) {
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError(43);
        }
        if (flags & 2) {
          return 0;
        }
        var buffer = HEAPU8.slice(addr, addr + len);
        FS.msync(stream, buffer, offset, len, flags);
      },
      getStreamFromFD(fd) {
        var stream = FS.getStreamChecked(fd);
        return stream;
      },
      varargs: undefined,
      getStr(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
      },
    };
    function ___syscall_fcntl64(fd, cmd, varargs) {
      SYSCALLS.varargs = varargs;
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        switch (cmd) {
          case 0: {
            var arg = syscallGetVarargI();
            if (arg < 0) {
              return -28;
            }
            while (FS.streams[arg]) {
              arg++;
            }
            var newStream;
            newStream = FS.dupStream(stream, arg);
            return newStream.fd;
          }
          case 1:
          case 2:
            return 0;
          case 3:
            return stream.flags;
          case 4: {
            var arg = syscallGetVarargI();
            stream.flags |= arg;
            return 0;
          }
          case 12: {
            var arg = syscallGetVarargP();
            var offset = 0;
            HEAP16[(arg + offset) >> 1] = 2;
            return 0;
          }
          case 13:
          case 14:
            return 0;
        }
        return -28;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_fstat64(fd, buf) {
      try {
        return SYSCALLS.writeStat(buf, FS.fstat(fd));
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    var INT53_MAX = 9007199254740992;
    var INT53_MIN = -9007199254740992;
    var bigintToI53Checked = (num) => (num < INT53_MIN || num > INT53_MAX ? NaN : Number(num));
    function ___syscall_ftruncate64(fd, length) {
      length = bigintToI53Checked(length);
      try {
        if (isNaN(length)) return -61;
        FS.ftruncate(fd, length);
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
      assert(
        typeof maxBytesToWrite == "number",
        "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!",
      );
      return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
    };
    function ___syscall_getdents64(fd, dirp, count) {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        stream.getdents ||= FS.readdir(stream.path);
        var struct_size = 280;
        var pos = 0;
        var off = FS.llseek(stream, 0, 1);
        var startIdx = Math.floor(off / struct_size);
        var endIdx = Math.min(stream.getdents.length, startIdx + Math.floor(count / struct_size));
        for (var idx = startIdx; idx < endIdx; idx++) {
          var id;
          var type;
          var name = stream.getdents[idx];
          if (name === ".") {
            id = stream.node.id;
            type = 4;
          } else if (name === "..") {
            var lookup = FS.lookupPath(stream.path, { parent: true });
            id = lookup.node.id;
            type = 4;
          } else {
            var child;
            try {
              child = FS.lookupNode(stream.node, name);
            } catch (e) {
              if (e?.errno === 28) {
                continue;
              }
              throw e;
            }
            id = child.id;
            type = FS.isChrdev(child.mode) ? 2 : FS.isDir(child.mode) ? 4 : FS.isLink(child.mode) ? 10 : 8;
          }
          assert(id);
          HEAP64[(dirp + pos) >> 3] = BigInt(id);
          HEAP64[(dirp + pos + 8) >> 3] = BigInt((idx + 1) * struct_size);
          HEAP16[(dirp + pos + 16) >> 1] = 280;
          HEAP8[dirp + pos + 18] = type;
          stringToUTF8(name, dirp + pos + 19, 256);
          pos += struct_size;
        }
        FS.llseek(stream, idx * struct_size, 0);
        return pos;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_ioctl(fd, op, varargs) {
      SYSCALLS.varargs = varargs;
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        switch (op) {
          case 21509: {
            if (!stream.tty) return -59;
            return 0;
          }
          case 21505: {
            if (!stream.tty) return -59;
            if (stream.tty.ops.ioctl_tcgets) {
              var termios = stream.tty.ops.ioctl_tcgets(stream);
              var argp = syscallGetVarargP();
              HEAP32[argp >> 2] = termios.c_iflag || 0;
              HEAP32[(argp + 4) >> 2] = termios.c_oflag || 0;
              HEAP32[(argp + 8) >> 2] = termios.c_cflag || 0;
              HEAP32[(argp + 12) >> 2] = termios.c_lflag || 0;
              for (var i = 0; i < 32; i++) {
                HEAP8[argp + i + 17] = termios.c_cc[i] || 0;
              }
              return 0;
            }
            return 0;
          }
          case 21510:
          case 21511:
          case 21512: {
            if (!stream.tty) return -59;
            return 0;
          }
          case 21506:
          case 21507:
          case 21508: {
            if (!stream.tty) return -59;
            if (stream.tty.ops.ioctl_tcsets) {
              var argp = syscallGetVarargP();
              var c_iflag = HEAP32[argp >> 2];
              var c_oflag = HEAP32[(argp + 4) >> 2];
              var c_cflag = HEAP32[(argp + 8) >> 2];
              var c_lflag = HEAP32[(argp + 12) >> 2];
              var c_cc = [];
              for (var i = 0; i < 32; i++) {
                c_cc.push(HEAP8[argp + i + 17]);
              }
              return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
                c_iflag,
                c_oflag,
                c_cflag,
                c_lflag,
                c_cc,
              });
            }
            return 0;
          }
          case 21519: {
            if (!stream.tty) return -59;
            var argp = syscallGetVarargP();
            HEAP32[argp >> 2] = 0;
            return 0;
          }
          case 21520: {
            if (!stream.tty) return -59;
            return -28;
          }
          case 21531: {
            var argp = syscallGetVarargP();
            return FS.ioctl(stream, op, argp);
          }
          case 21523: {
            if (!stream.tty) return -59;
            if (stream.tty.ops.ioctl_tiocgwinsz) {
              var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
              var argp = syscallGetVarargP();
              HEAP16[argp >> 1] = winsize[0];
              HEAP16[(argp + 2) >> 1] = winsize[1];
            }
            return 0;
          }
          case 21524: {
            if (!stream.tty) return -59;
            return 0;
          }
          case 21515: {
            if (!stream.tty) return -59;
            return 0;
          }
          default:
            return -28;
        }
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_lstat64(path, buf) {
      try {
        path = SYSCALLS.getStr(path);
        return SYSCALLS.writeStat(buf, FS.lstat(path));
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_newfstatat(dirfd, path, buf, flags) {
      try {
        path = SYSCALLS.getStr(path);
        var nofollow = flags & 256;
        var allowEmpty = flags & 4096;
        flags = flags & ~6400;
        assert(!flags, `unknown flags in __syscall_newfstatat: ${flags}`);
        path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
        return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_openat(dirfd, path, flags, varargs) {
      SYSCALLS.varargs = varargs;
      try {
        path = SYSCALLS.getStr(path);
        path = SYSCALLS.calculateAt(dirfd, path);
        var mode = varargs ? syscallGetVarargI() : 0;
        return FS.open(path, flags, mode).fd;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_rmdir(path) {
      try {
        path = SYSCALLS.getStr(path);
        FS.rmdir(path);
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_stat64(path, buf) {
      try {
        path = SYSCALLS.getStr(path);
        return SYSCALLS.writeStat(buf, FS.stat(path));
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    function ___syscall_unlinkat(dirfd, path, flags) {
      try {
        path = SYSCALLS.getStr(path);
        path = SYSCALLS.calculateAt(dirfd, path);
        if (!flags) {
          FS.unlink(path);
        } else if (flags === 512) {
          FS.rmdir(path);
        } else {
          return -28;
        }
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return -e.errno;
      }
    }
    var __abort_js = () => abort("native code called abort()");
    var __emscripten_throw_longjmp = () => {
      throw Infinity;
    };
    function __gmtime_js(time, tmPtr) {
      time = bigintToI53Checked(time);
      var date = new Date(time * 1e3);
      HEAP32[tmPtr >> 2] = date.getUTCSeconds();
      HEAP32[(tmPtr + 4) >> 2] = date.getUTCMinutes();
      HEAP32[(tmPtr + 8) >> 2] = date.getUTCHours();
      HEAP32[(tmPtr + 12) >> 2] = date.getUTCDate();
      HEAP32[(tmPtr + 16) >> 2] = date.getUTCMonth();
      HEAP32[(tmPtr + 20) >> 2] = date.getUTCFullYear() - 1900;
      HEAP32[(tmPtr + 24) >> 2] = date.getUTCDay();
      var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
      var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
      HEAP32[(tmPtr + 28) >> 2] = yday;
    }
    var isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    var MONTH_DAYS_LEAP_CUMULATIVE = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    var MONTH_DAYS_REGULAR_CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var ydayFromDate = (date) => {
      var leap = isLeapYear(date.getFullYear());
      var monthDaysCumulative = leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE;
      var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
      return yday;
    };
    function __localtime_js(time, tmPtr) {
      time = bigintToI53Checked(time);
      var date = new Date(time * 1e3);
      HEAP32[tmPtr >> 2] = date.getSeconds();
      HEAP32[(tmPtr + 4) >> 2] = date.getMinutes();
      HEAP32[(tmPtr + 8) >> 2] = date.getHours();
      HEAP32[(tmPtr + 12) >> 2] = date.getDate();
      HEAP32[(tmPtr + 16) >> 2] = date.getMonth();
      HEAP32[(tmPtr + 20) >> 2] = date.getFullYear() - 1900;
      HEAP32[(tmPtr + 24) >> 2] = date.getDay();
      var yday = ydayFromDate(date) | 0;
      HEAP32[(tmPtr + 28) >> 2] = yday;
      HEAP32[(tmPtr + 36) >> 2] = -(date.getTimezoneOffset() * 60);
      var start = new Date(date.getFullYear(), 0, 1);
      var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      var winterOffset = start.getTimezoneOffset();
      var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
      HEAP32[(tmPtr + 32) >> 2] = dst;
    }
    var __tzset_js = (timezone, daylight, std_name, dst_name) => {
      var currentYear = new Date().getFullYear();
      var winter = new Date(currentYear, 0, 1);
      var summer = new Date(currentYear, 6, 1);
      var winterOffset = winter.getTimezoneOffset();
      var summerOffset = summer.getTimezoneOffset();
      var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
      HEAPU32[timezone >> 2] = stdTimezoneOffset * 60;
      HEAP32[daylight >> 2] = Number(winterOffset != summerOffset);
      var extractZone = (timezoneOffset) => {
        var sign = timezoneOffset >= 0 ? "-" : "+";
        var absOffset = Math.abs(timezoneOffset);
        var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
        var minutes = String(absOffset % 60).padStart(2, "0");
        return `UTC${sign}${hours}${minutes}`;
      };
      var winterName = extractZone(winterOffset);
      var summerName = extractZone(summerOffset);
      assert(winterName);
      assert(summerName);
      assert(lengthBytesUTF8(winterName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${winterName})`);
      assert(lengthBytesUTF8(summerName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${summerName})`);
      if (summerOffset < winterOffset) {
        stringToUTF8(winterName, std_name, 17);
        stringToUTF8(summerName, dst_name, 17);
      } else {
        stringToUTF8(winterName, dst_name, 17);
        stringToUTF8(summerName, std_name, 17);
      }
    };
    var _emscripten_date_now = () => Date.now();
    var getHeapMax = () => 2147483648;
    var growMemory = (size) => {
      var b = wasmMemory.buffer;
      var pages = ((size - b.byteLength + 65535) / 65536) | 0;
      try {
        wasmMemory.grow(pages);
        updateMemoryViews();
        return 1;
      } catch (e) {
        err(`growMemory: Attempted to grow heap from ${b.byteLength} bytes to ${size} bytes, but got error: ${e}`);
      }
    };
    var _emscripten_resize_heap = (requestedSize) => {
      var oldSize = HEAPU8.length;
      requestedSize >>>= 0;
      assert(requestedSize > oldSize);
      var maxHeapSize = getHeapMax();
      if (requestedSize > maxHeapSize) {
        err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
        return false;
      }
      for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) {
          return true;
        }
      }
      err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
      return false;
    };
    var ENV = {};
    var getExecutableName = () => thisProgram || "./this.program";
    var getEnvStrings = () => {
      if (!getEnvStrings.strings) {
        var lang = ((typeof navigator == "object" && navigator.language) || "C").replace("-", "_") + ".UTF-8";
        var env = {
          USER: "web_user",
          LOGNAME: "web_user",
          PATH: "/",
          PWD: "/",
          HOME: "/home/web_user",
          LANG: lang,
          _: getExecutableName(),
        };
        for (var x in ENV) {
          if (ENV[x] === undefined) delete env[x];
          else env[x] = ENV[x];
        }
        var strings = [];
        for (var x in env) {
          strings.push(`${x}=${env[x]}`);
        }
        getEnvStrings.strings = strings;
      }
      return getEnvStrings.strings;
    };
    var _environ_get = (__environ, environ_buf) => {
      var bufSize = 0;
      var envp = 0;
      for (var string of getEnvStrings()) {
        var ptr = environ_buf + bufSize;
        HEAPU32[(__environ + envp) >> 2] = ptr;
        bufSize += stringToUTF8(string, ptr, Infinity) + 1;
        envp += 4;
      }
      return 0;
    };
    var _environ_sizes_get = (penviron_count, penviron_buf_size) => {
      var strings = getEnvStrings();
      HEAPU32[penviron_count >> 2] = strings.length;
      var bufSize = 0;
      for (var string of strings) {
        bufSize += lengthBytesUTF8(string) + 1;
      }
      HEAPU32[penviron_buf_size >> 2] = bufSize;
      return 0;
    };
    function _fd_close(fd) {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        FS.close(stream);
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
      }
    }
    var doReadv = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >> 2];
        var len = HEAPU32[(iov + 4) >> 2];
        iov += 8;
        var curr = FS.read(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) break;
      }
      return ret;
    };
    function _fd_read(fd, iov, iovcnt, pnum) {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doReadv(stream, iov, iovcnt);
        HEAPU32[pnum >> 2] = num;
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
      }
    }
    function _fd_seek(fd, offset, whence, newOffset) {
      offset = bigintToI53Checked(offset);
      try {
        if (isNaN(offset)) return 61;
        var stream = SYSCALLS.getStreamFromFD(fd);
        FS.llseek(stream, offset, whence);
        HEAP64[newOffset >> 3] = BigInt(stream.position);
        if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
      }
    }
    function _fd_sync(fd) {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        if (stream.stream_ops?.fsync) {
          return stream.stream_ops.fsync(stream);
        }
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
      }
    }
    var doWritev = (stream, iov, iovcnt, offset) => {
      var ret = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >> 2];
        var len = HEAPU32[(iov + 4) >> 2];
        iov += 8;
        var curr = FS.write(stream, HEAP8, ptr, len, offset);
        if (curr < 0) return -1;
        ret += curr;
        if (curr < len) {
          break;
        }
      }
      return ret;
    };
    function _fd_write(fd, iov, iovcnt, pnum) {
      try {
        var stream = SYSCALLS.getStreamFromFD(fd);
        var num = doWritev(stream, iov, iovcnt);
        HEAPU32[pnum >> 2] = num;
        return 0;
      } catch (e) {
        if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
        return e.errno;
      }
    }
    var wasmTableMirror = [];
    var wasmTable;
    var getWasmTableEntry = (funcPtr) => {
      var func = wasmTableMirror[funcPtr];
      if (!func) {
        wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
      }
      assert(wasmTable.get(funcPtr) == func, "JavaScript-side Wasm function table mirror is out of date!");
      return func;
    };
    var getCFunc = (ident) => {
      var func = Module["_" + ident];
      assert(func, "Cannot call unknown function " + ident + ", make sure it is exported");
      return func;
    };
    var writeArrayToMemory = (array, buffer) => {
      assert(array.length >= 0, "writeArrayToMemory array must have a length (should be an array or typed array)");
      HEAP8.set(array, buffer);
    };
    var stackAlloc = (sz) => __emscripten_stack_alloc(sz);
    var stringToUTF8OnStack = (str) => {
      var size = lengthBytesUTF8(str) + 1;
      var ret = stackAlloc(size);
      stringToUTF8(str, ret, size);
      return ret;
    };
    var ccall = (ident, returnType, argTypes, args, opts) => {
      var toC = {
        string: (str) => {
          var ret = 0;
          if (str !== null && str !== undefined && str !== 0) {
            ret = stringToUTF8OnStack(str);
          }
          return ret;
        },
        array: (arr) => {
          var ret = stackAlloc(arr.length);
          writeArrayToMemory(arr, ret);
          return ret;
        },
      };
      function convertReturnValue(ret) {
        if (returnType === "string") {
          return UTF8ToString(ret);
        }
        if (returnType === "boolean") return Boolean(ret);
        return ret;
      }
      var func = getCFunc(ident);
      var cArgs = [];
      var stack = 0;
      assert(returnType !== "array", 'Return type should not be "array".');
      if (args) {
        for (var i = 0; i < args.length; i++) {
          var converter = toC[argTypes[i]];
          if (converter) {
            if (stack === 0) stack = stackSave();
            cArgs[i] = converter(args[i]);
          } else {
            cArgs[i] = args[i];
          }
        }
      }
      var ret = func(...cArgs);
      function onDone(ret) {
        if (stack !== 0) stackRestore(stack);
        return convertReturnValue(ret);
      }
      ret = onDone(ret);
      return ret;
    };
    var cwrap =
      (ident, returnType, argTypes, opts) =>
      (...args) =>
        ccall(ident, returnType, argTypes, args);
    FS.createPreloadedFile = FS_createPreloadedFile;
    FS.staticInit();
    {
      if (Module["noExitRuntime"]) Module["noExitRuntime"];
      if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
      if (Module["print"]) out = Module["print"];
      if (Module["printErr"]) err = Module["printErr"];
      if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
      checkIncomingModuleAPI();
      if (Module["arguments"]) Module["arguments"];
      if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
      assert(
        typeof Module["memoryInitializerPrefixURL"] == "undefined",
        "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead",
      );
      assert(
        typeof Module["pthreadMainPrefixURL"] == "undefined",
        "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead",
      );
      assert(
        typeof Module["cdInitializerPrefixURL"] == "undefined",
        "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead",
      );
      assert(
        typeof Module["filePackagePrefixURL"] == "undefined",
        "Module.filePackagePrefixURL option was removed, use Module.locateFile instead",
      );
      assert(typeof Module["read"] == "undefined", "Module.read option was removed");
      assert(typeof Module["readAsync"] == "undefined", "Module.readAsync option was removed (modify readAsync in JS)");
      assert(
        typeof Module["readBinary"] == "undefined",
        "Module.readBinary option was removed (modify readBinary in JS)",
      );
      assert(
        typeof Module["setWindowTitle"] == "undefined",
        "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)",
      );
      assert(
        typeof Module["TOTAL_MEMORY"] == "undefined",
        "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY",
      );
      assert(
        typeof Module["ENVIRONMENT"] == "undefined",
        "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)",
      );
      assert(
        typeof Module["STACK_SIZE"] == "undefined",
        "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time",
      );
      assert(
        typeof Module["wasmMemory"] == "undefined",
        "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally",
      );
      assert(
        typeof Module["INITIAL_MEMORY"] == "undefined",
        "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically",
      );
    }
    Module["wasmExports"] = wasmExports;
    Module["ccall"] = ccall;
    Module["cwrap"] = cwrap;
    var missingLibrarySymbols = [
      "writeI53ToI64",
      "writeI53ToI64Clamped",
      "writeI53ToI64Signaling",
      "writeI53ToU64Clamped",
      "writeI53ToU64Signaling",
      "readI53FromI64",
      "readI53FromU64",
      "convertI32PairToI53",
      "convertI32PairToI53Checked",
      "convertU32PairToI53",
      "getTempRet0",
      "setTempRet0",
      "exitJS",
      "withStackSave",
      "inetPton4",
      "inetNtop4",
      "inetPton6",
      "inetNtop6",
      "readSockaddr",
      "writeSockaddr",
      "emscriptenLog",
      "readEmAsmArgs",
      "jstoi_q",
      "autoResumeAudioContext",
      "getDynCaller",
      "dynCall",
      "handleException",
      "keepRuntimeAlive",
      "runtimeKeepalivePush",
      "runtimeKeepalivePop",
      "callUserCallback",
      "maybeExit",
      "asmjsMangle",
      "HandleAllocator",
      "getNativeTypeSize",
      "addOnInit",
      "addOnPostCtor",
      "addOnPreMain",
      "addOnExit",
      "STACK_SIZE",
      "STACK_ALIGN",
      "POINTER_SIZE",
      "ASSERTIONS",
      "uleb128Encode",
      "sigToWasmTypes",
      "generateFuncType",
      "convertJsFunctionToWasm",
      "getEmptyTableSlot",
      "updateTableMap",
      "getFunctionAddress",
      "addFunction",
      "removeFunction",
      "reallyNegative",
      "unSign",
      "strLen",
      "reSign",
      "formatString",
      "intArrayToString",
      "AsciiToString",
      "stringToAscii",
      "UTF16ToString",
      "stringToUTF16",
      "lengthBytesUTF16",
      "UTF32ToString",
      "stringToUTF32",
      "lengthBytesUTF32",
      "stringToNewUTF8",
      "registerKeyEventCallback",
      "maybeCStringToJsString",
      "findEventTarget",
      "getBoundingClientRect",
      "fillMouseEventData",
      "registerMouseEventCallback",
      "registerWheelEventCallback",
      "registerUiEventCallback",
      "registerFocusEventCallback",
      "fillDeviceOrientationEventData",
      "registerDeviceOrientationEventCallback",
      "fillDeviceMotionEventData",
      "registerDeviceMotionEventCallback",
      "screenOrientation",
      "fillOrientationChangeEventData",
      "registerOrientationChangeEventCallback",
      "fillFullscreenChangeEventData",
      "registerFullscreenChangeEventCallback",
      "JSEvents_requestFullscreen",
      "JSEvents_resizeCanvasForFullscreen",
      "registerRestoreOldStyle",
      "hideEverythingExceptGivenElement",
      "restoreHiddenElements",
      "setLetterbox",
      "softFullscreenResizeWebGLRenderTarget",
      "doRequestFullscreen",
      "fillPointerlockChangeEventData",
      "registerPointerlockChangeEventCallback",
      "registerPointerlockErrorEventCallback",
      "requestPointerLock",
      "fillVisibilityChangeEventData",
      "registerVisibilityChangeEventCallback",
      "registerTouchEventCallback",
      "fillGamepadEventData",
      "registerGamepadEventCallback",
      "registerBeforeUnloadEventCallback",
      "fillBatteryEventData",
      "battery",
      "registerBatteryEventCallback",
      "setCanvasElementSize",
      "getCanvasElementSize",
      "jsStackTrace",
      "getCallstack",
      "convertPCtoSourceLocation",
      "checkWasiClock",
      "wasiRightsToMuslOFlags",
      "wasiOFlagsToMuslOFlags",
      "safeSetTimeout",
      "setImmediateWrapped",
      "safeRequestAnimationFrame",
      "clearImmediateWrapped",
      "registerPostMainLoop",
      "registerPreMainLoop",
      "getPromise",
      "makePromise",
      "idsToPromises",
      "makePromiseCallback",
      "ExceptionInfo",
      "findMatchingCatch",
      "Browser_asyncPrepareDataCounter",
      "arraySum",
      "addDays",
      "getSocketFromFD",
      "getSocketAddress",
      "FS_mkdirTree",
      "_setNetworkCallback",
      "heapObjectForWebGLType",
      "toTypedArrayIndex",
      "webgl_enable_ANGLE_instanced_arrays",
      "webgl_enable_OES_vertex_array_object",
      "webgl_enable_WEBGL_draw_buffers",
      "webgl_enable_WEBGL_multi_draw",
      "webgl_enable_EXT_polygon_offset_clamp",
      "webgl_enable_EXT_clip_control",
      "webgl_enable_WEBGL_polygon_mode",
      "emscriptenWebGLGet",
      "computeUnpackAlignedImageSize",
      "colorChannelsInGlTextureFormat",
      "emscriptenWebGLGetTexPixelData",
      "emscriptenWebGLGetUniform",
      "webglGetUniformLocation",
      "webglPrepareUniformLocationsBeforeFirstUse",
      "webglGetLeftBracePos",
      "emscriptenWebGLGetVertexAttrib",
      "__glGetActiveAttribOrUniform",
      "writeGLArray",
      "registerWebGlEventCallback",
      "runAndAbortIfError",
      "ALLOC_NORMAL",
      "ALLOC_STACK",
      "allocate",
      "writeStringToMemory",
      "writeAsciiToMemory",
      "demangle",
      "stackTrace",
    ];
    missingLibrarySymbols.forEach(missingLibrarySymbol);
    var unexportedSymbols = [
      "run",
      "addRunDependency",
      "removeRunDependency",
      "out",
      "err",
      "callMain",
      "abort",
      "wasmMemory",
      "HEAP64",
      "HEAPU64",
      "writeStackCookie",
      "checkStackCookie",
      "INT53_MAX",
      "INT53_MIN",
      "bigintToI53Checked",
      "stackSave",
      "stackRestore",
      "stackAlloc",
      "ptrToString",
      "zeroMemory",
      "getHeapMax",
      "growMemory",
      "ENV",
      "ERRNO_CODES",
      "strError",
      "DNS",
      "Protocols",
      "Sockets",
      "timers",
      "warnOnce",
      "readEmAsmArgsArray",
      "getExecutableName",
      "asyncLoad",
      "alignMemory",
      "mmapAlloc",
      "wasmTable",
      "getUniqueRunDependency",
      "noExitRuntime",
      "addOnPreRun",
      "addOnPostRun",
      "freeTableIndexes",
      "functionsInTableMap",
      "setValue",
      "getValue",
      "PATH",
      "PATH_FS",
      "UTF8Decoder",
      "UTF8ArrayToString",
      "UTF8ToString",
      "stringToUTF8Array",
      "stringToUTF8",
      "lengthBytesUTF8",
      "intArrayFromString",
      "UTF16Decoder",
      "stringToUTF8OnStack",
      "writeArrayToMemory",
      "JSEvents",
      "specialHTMLTargets",
      "findCanvasEventTarget",
      "currentFullscreenStrategy",
      "restoreOldWindowedStyle",
      "UNWIND_CACHE",
      "ExitStatus",
      "getEnvStrings",
      "doReadv",
      "doWritev",
      "initRandomFill",
      "randomFill",
      "emSetImmediate",
      "emClearImmediate_deps",
      "emClearImmediate",
      "promiseMap",
      "uncaughtExceptionCount",
      "exceptionLast",
      "exceptionCaught",
      "Browser",
      "requestFullscreen",
      "requestFullScreen",
      "setCanvasSize",
      "getUserMedia",
      "createContext",
      "getPreloadedImageData__data",
      "wget",
      "MONTH_DAYS_REGULAR",
      "MONTH_DAYS_LEAP",
      "MONTH_DAYS_REGULAR_CUMULATIVE",
      "MONTH_DAYS_LEAP_CUMULATIVE",
      "isLeapYear",
      "ydayFromDate",
      "SYSCALLS",
      "preloadPlugins",
      "FS_createPreloadedFile",
      "FS_modeStringToFlags",
      "FS_getMode",
      "FS_stdin_getChar_buffer",
      "FS_stdin_getChar",
      "FS_unlink",
      "FS_createPath",
      "FS_createDevice",
      "FS_readFile",
      "FS",
      "FS_root",
      "FS_mounts",
      "FS_devices",
      "FS_streams",
      "FS_nextInode",
      "FS_nameTable",
      "FS_currentPath",
      "FS_initialized",
      "FS_ignorePermissions",
      "FS_filesystems",
      "FS_syncFSRequests",
      "FS_readFiles",
      "FS_lookupPath",
      "FS_getPath",
      "FS_hashName",
      "FS_hashAddNode",
      "FS_hashRemoveNode",
      "FS_lookupNode",
      "FS_createNode",
      "FS_destroyNode",
      "FS_isRoot",
      "FS_isMountpoint",
      "FS_isFile",
      "FS_isDir",
      "FS_isLink",
      "FS_isChrdev",
      "FS_isBlkdev",
      "FS_isFIFO",
      "FS_isSocket",
      "FS_flagsToPermissionString",
      "FS_nodePermissions",
      "FS_mayLookup",
      "FS_mayCreate",
      "FS_mayDelete",
      "FS_mayOpen",
      "FS_checkOpExists",
      "FS_nextfd",
      "FS_getStreamChecked",
      "FS_getStream",
      "FS_createStream",
      "FS_closeStream",
      "FS_dupStream",
      "FS_doSetAttr",
      "FS_chrdev_stream_ops",
      "FS_major",
      "FS_minor",
      "FS_makedev",
      "FS_registerDevice",
      "FS_getDevice",
      "FS_getMounts",
      "FS_syncfs",
      "FS_mount",
      "FS_unmount",
      "FS_lookup",
      "FS_mknod",
      "FS_statfs",
      "FS_statfsStream",
      "FS_statfsNode",
      "FS_create",
      "FS_mkdir",
      "FS_mkdev",
      "FS_symlink",
      "FS_rename",
      "FS_rmdir",
      "FS_readdir",
      "FS_readlink",
      "FS_stat",
      "FS_fstat",
      "FS_lstat",
      "FS_doChmod",
      "FS_chmod",
      "FS_lchmod",
      "FS_fchmod",
      "FS_doChown",
      "FS_chown",
      "FS_lchown",
      "FS_fchown",
      "FS_doTruncate",
      "FS_truncate",
      "FS_ftruncate",
      "FS_utime",
      "FS_open",
      "FS_close",
      "FS_isClosed",
      "FS_llseek",
      "FS_read",
      "FS_write",
      "FS_mmap",
      "FS_msync",
      "FS_ioctl",
      "FS_writeFile",
      "FS_cwd",
      "FS_chdir",
      "FS_createDefaultDirectories",
      "FS_createDefaultDevices",
      "FS_createSpecialDirectories",
      "FS_createStandardStreams",
      "FS_staticInit",
      "FS_init",
      "FS_quit",
      "FS_findObject",
      "FS_analyzePath",
      "FS_createFile",
      "FS_createDataFile",
      "FS_forceLoadFile",
      "FS_createLazyFile",
      "FS_absolutePath",
      "FS_createFolder",
      "FS_createLink",
      "FS_joinPath",
      "FS_mmapAlloc",
      "FS_standardizePath",
      "MEMFS",
      "TTY",
      "PIPEFS",
      "SOCKFS",
      "tempFixedLengthArray",
      "miniTempWebGLFloatBuffers",
      "miniTempWebGLIntBuffers",
      "GL",
      "AL",
      "GLUT",
      "EGL",
      "GLEW",
      "IDBStore",
      "SDL",
      "SDL_gfx",
      "allocateUTF8",
      "allocateUTF8OnStack",
      "print",
      "printErr",
      "jstoi_s",
    ];
    unexportedSymbols.forEach(unexportedRuntimeSymbol);
    function checkIncomingModuleAPI() {
      ignoredModuleProp("fetchSettings");
    }
    (Module["_PDFium_Init"] = makeInvalidEarlyAccess("_PDFium_Init"));
    (Module["_FPDF_InitLibraryWithConfig"] =
      makeInvalidEarlyAccess("_FPDF_InitLibraryWithConfig"));
    (Module["_FPDFAnnot_IsSupportedSubtype"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_IsSupportedSubtype",
    ));
    (Module["_FPDFPage_CreateAnnot"] = makeInvalidEarlyAccess("_FPDFPage_CreateAnnot"));
    (Module["_FPDFPage_GetAnnotCount"] =
      makeInvalidEarlyAccess("_FPDFPage_GetAnnotCount"));
    (Module["_FPDFPage_GetAnnot"] = makeInvalidEarlyAccess("_FPDFPage_GetAnnot"));
    (Module["_FPDFPage_GetAnnotIndex"] =
      makeInvalidEarlyAccess("_FPDFPage_GetAnnotIndex"));
    (Module["_FPDFPage_CloseAnnot"] = makeInvalidEarlyAccess("_FPDFPage_CloseAnnot"));
    (Module["_FPDFPage_RemoveAnnot"] = makeInvalidEarlyAccess("_FPDFPage_RemoveAnnot"));
    (Module["_FPDFAnnot_GetSubtype"] = makeInvalidEarlyAccess("_FPDFAnnot_GetSubtype"));
    (Module["_FPDFAnnot_IsObjectSupportedSubtype"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_IsObjectSupportedSubtype",
    ));
    (Module["_FPDFAnnot_UpdateObject"] =
      makeInvalidEarlyAccess("_FPDFAnnot_UpdateObject"));
    (Module["_FPDFAnnot_AddInkStroke"] =
      makeInvalidEarlyAccess("_FPDFAnnot_AddInkStroke"));
    (Module["_FPDFAnnot_RemoveInkList"] =
      makeInvalidEarlyAccess("_FPDFAnnot_RemoveInkList"));
    (Module["_FPDFAnnot_AppendObject"] =
      makeInvalidEarlyAccess("_FPDFAnnot_AppendObject"));
    (Module["_FPDFAnnot_GetObjectCount"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetObjectCount"));
    (Module["_FPDFAnnot_GetObject"] = makeInvalidEarlyAccess("_FPDFAnnot_GetObject"));
    (Module["_FPDFAnnot_RemoveObject"] =
      makeInvalidEarlyAccess("_FPDFAnnot_RemoveObject"));
    (Module["_FPDFAnnot_SetColor"] = makeInvalidEarlyAccess("_FPDFAnnot_SetColor"));
    (Module["_FPDFAnnot_GetColor"] = makeInvalidEarlyAccess("_FPDFAnnot_GetColor"));
    (Module["_FPDFAnnot_HasAttachmentPoints"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_HasAttachmentPoints",
    ));
    (Module["_FPDFAnnot_SetAttachmentPoints"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_SetAttachmentPoints",
    ));
    (Module["_FPDFAnnot_AppendAttachmentPoints"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_AppendAttachmentPoints",
    ));
    (Module["_FPDFAnnot_CountAttachmentPoints"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_CountAttachmentPoints",
    ));
    (Module["_FPDFAnnot_GetAttachmentPoints"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetAttachmentPoints",
    ));
    (Module["_FPDFAnnot_SetRect"] = makeInvalidEarlyAccess("_FPDFAnnot_SetRect"));
    (Module["_FPDFAnnot_GetRect"] = makeInvalidEarlyAccess("_FPDFAnnot_GetRect"));
    (Module["_FPDFAnnot_GetVertices"] = makeInvalidEarlyAccess("_FPDFAnnot_GetVertices"));
    (Module["_FPDFAnnot_GetInkListCount"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetInkListCount"));
    (Module["_FPDFAnnot_GetInkListPath"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetInkListPath"));
    (Module["_FPDFAnnot_GetLine"] = makeInvalidEarlyAccess("_FPDFAnnot_GetLine"));
    (Module["_FPDFAnnot_SetBorder"] = makeInvalidEarlyAccess("_FPDFAnnot_SetBorder"));
    (Module["_FPDFAnnot_GetBorder"] = makeInvalidEarlyAccess("_FPDFAnnot_GetBorder"));
    (Module["_FPDFAnnot_HasKey"] = makeInvalidEarlyAccess("_FPDFAnnot_HasKey"));
    (Module["_FPDFAnnot_GetValueType"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetValueType"));
    (Module["_FPDFAnnot_SetStringValue"] =
      makeInvalidEarlyAccess("_FPDFAnnot_SetStringValue"));
    (Module["_FPDFAnnot_GetStringValue"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetStringValue"));
    (Module["_FPDFAnnot_GetNumberValue"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetNumberValue"));
    (Module["_FPDFAnnot_SetAP"] = makeInvalidEarlyAccess("_FPDFAnnot_SetAP"));
    (Module["_FPDFAnnot_GetAP"] = makeInvalidEarlyAccess("_FPDFAnnot_GetAP"));
    (Module["_FPDFAnnot_GetLinkedAnnot"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetLinkedAnnot"));
    (Module["_FPDFAnnot_GetFlags"] = makeInvalidEarlyAccess("_FPDFAnnot_GetFlags"));
    (Module["_FPDFAnnot_SetFlags"] = makeInvalidEarlyAccess("_FPDFAnnot_SetFlags"));
    (Module["_FPDFAnnot_GetFormFieldFlags"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFormFieldFlags"));
    (Module["_FPDFAnnot_SetFormFieldFlags"] =
      makeInvalidEarlyAccess("_FPDFAnnot_SetFormFieldFlags"));
    (Module["_FPDFAnnot_GetFormFieldAtPoint"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFormFieldAtPoint",
    ));
    (Module["_FPDFAnnot_GetFormFieldName"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFormFieldName"));
    (Module["_FPDFAnnot_GetFormFieldType"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFormFieldType"));
    (Module["_FPDFAnnot_GetFormAdditionalActionJavaScript"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFormAdditionalActionJavaScript"));
    (Module["_FPDFAnnot_GetFormFieldAlternateName"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFormFieldAlternateName",
    ));
    (Module["_FPDFAnnot_GetFormFieldValue"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFormFieldValue"));
    (Module["_FPDFAnnot_GetOptionCount"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetOptionCount"));
    (Module["_FPDFAnnot_GetOptionLabel"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetOptionLabel"));
    (Module["_FPDFAnnot_IsOptionSelected"] =
      makeInvalidEarlyAccess("_FPDFAnnot_IsOptionSelected"));
    (Module["_FPDFAnnot_GetFontSize"] = makeInvalidEarlyAccess("_FPDFAnnot_GetFontSize"));
    (Module["_FPDFAnnot_SetFontColor"] =
      makeInvalidEarlyAccess("_FPDFAnnot_SetFontColor"));
    (Module["_FPDFAnnot_GetFontColor"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFontColor"));
    (Module["_FPDFAnnot_IsChecked"] = makeInvalidEarlyAccess("_FPDFAnnot_IsChecked"));
    (Module["_FPDFAnnot_SetFocusableSubtypes"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_SetFocusableSubtypes",
    ));
    (Module["_FPDFAnnot_GetFocusableSubtypesCount"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFocusableSubtypesCount",
    ));
    (Module["_FPDFAnnot_GetFocusableSubtypes"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFocusableSubtypes",
    ));
    (Module["_FPDFAnnot_GetLink"] = makeInvalidEarlyAccess("_FPDFAnnot_GetLink"));
    (Module["_FPDFAnnot_GetFormControlCount"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFormControlCount",
    ));
    (Module["_FPDFAnnot_GetFormControlIndex"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFormControlIndex",
    ));
    (Module["_FPDFAnnot_GetFormFieldExportValue"] = makeInvalidEarlyAccess(
      "_FPDFAnnot_GetFormFieldExportValue",
    ));
    (Module["_FPDFAnnot_SetURI"] = makeInvalidEarlyAccess("_FPDFAnnot_SetURI"));
    (Module["_FPDFAnnot_GetFileAttachment"] =
      makeInvalidEarlyAccess("_FPDFAnnot_GetFileAttachment"));
    (Module["_FPDFAnnot_AddFileAttachment"] =
      makeInvalidEarlyAccess("_FPDFAnnot_AddFileAttachment"));
    (Module["_FPDFDoc_GetAttachmentCount"] =
      makeInvalidEarlyAccess("_FPDFDoc_GetAttachmentCount"));
    (Module["_FPDFDoc_AddAttachment"] = makeInvalidEarlyAccess("_FPDFDoc_AddAttachment"));
    (Module["_FPDFDoc_GetAttachment"] = makeInvalidEarlyAccess("_FPDFDoc_GetAttachment"));
    (Module["_FPDFDoc_DeleteAttachment"] =
      makeInvalidEarlyAccess("_FPDFDoc_DeleteAttachment"));
    (Module["_FPDFAttachment_GetName"] =
      makeInvalidEarlyAccess("_FPDFAttachment_GetName"));
    (Module["_FPDFAttachment_HasKey"] = makeInvalidEarlyAccess("_FPDFAttachment_HasKey"));
    (Module["_FPDFAttachment_GetValueType"] =
      makeInvalidEarlyAccess("_FPDFAttachment_GetValueType"));
    (Module["_FPDFAttachment_SetStringValue"] = makeInvalidEarlyAccess(
      "_FPDFAttachment_SetStringValue",
    ));
    (Module["_FPDFAttachment_GetStringValue"] = makeInvalidEarlyAccess(
      "_FPDFAttachment_GetStringValue",
    ));
    (Module["_FPDFAttachment_SetFile"] =
      makeInvalidEarlyAccess("_FPDFAttachment_SetFile"));
    (Module["_FPDFAttachment_GetFile"] =
      makeInvalidEarlyAccess("_FPDFAttachment_GetFile"));
    (Module["_FPDFAttachment_GetSubtype"] =
      makeInvalidEarlyAccess("_FPDFAttachment_GetSubtype"));
    (Module["_FPDFCatalog_IsTagged"] = makeInvalidEarlyAccess("_FPDFCatalog_IsTagged"));
    (Module["_FPDFCatalog_SetLanguage"] =
      makeInvalidEarlyAccess("_FPDFCatalog_SetLanguage"));
    (Module["_FPDFAvail_Create"] = makeInvalidEarlyAccess("_FPDFAvail_Create"));
    (Module["_FPDFAvail_Destroy"] = makeInvalidEarlyAccess("_FPDFAvail_Destroy"));
    (Module["_FPDFAvail_IsDocAvail"] = makeInvalidEarlyAccess("_FPDFAvail_IsDocAvail"));
    (Module["_FPDFAvail_GetDocument"] = makeInvalidEarlyAccess("_FPDFAvail_GetDocument"));
    (Module["_FPDFAvail_GetFirstPageNum"] =
      makeInvalidEarlyAccess("_FPDFAvail_GetFirstPageNum"));
    (Module["_FPDFAvail_IsPageAvail"] = makeInvalidEarlyAccess("_FPDFAvail_IsPageAvail"));
    (Module["_FPDFAvail_IsFormAvail"] = makeInvalidEarlyAccess("_FPDFAvail_IsFormAvail"));
    (Module["_FPDFAvail_IsLinearized"] =
      makeInvalidEarlyAccess("_FPDFAvail_IsLinearized"));
    (Module["_FPDFBookmark_GetFirstChild"] =
      makeInvalidEarlyAccess("_FPDFBookmark_GetFirstChild"));
    (Module["_FPDFBookmark_GetNextSibling"] =
      makeInvalidEarlyAccess("_FPDFBookmark_GetNextSibling"));
    (Module["_FPDFBookmark_GetTitle"] = makeInvalidEarlyAccess("_FPDFBookmark_GetTitle"));
    (Module["_FPDFBookmark_GetCount"] = makeInvalidEarlyAccess("_FPDFBookmark_GetCount"));
    (Module["_FPDFBookmark_Find"] = makeInvalidEarlyAccess("_FPDFBookmark_Find"));
    (Module["_FPDFBookmark_GetDest"] = makeInvalidEarlyAccess("_FPDFBookmark_GetDest"));
    (Module["_FPDFBookmark_GetAction"] =
      makeInvalidEarlyAccess("_FPDFBookmark_GetAction"));
    (Module["_FPDFAction_GetType"] = makeInvalidEarlyAccess("_FPDFAction_GetType"));
    (Module["_FPDFAction_GetDest"] = makeInvalidEarlyAccess("_FPDFAction_GetDest"));
    (Module["_FPDFAction_GetFilePath"] =
      makeInvalidEarlyAccess("_FPDFAction_GetFilePath"));
    (Module["_FPDFAction_GetURIPath"] = makeInvalidEarlyAccess("_FPDFAction_GetURIPath"));
    (Module["_FPDFDest_GetDestPageIndex"] =
      makeInvalidEarlyAccess("_FPDFDest_GetDestPageIndex"));
    (Module["_FPDFDest_GetView"] = makeInvalidEarlyAccess("_FPDFDest_GetView"));
    (Module["_FPDFDest_GetLocationInPage"] =
      makeInvalidEarlyAccess("_FPDFDest_GetLocationInPage"));
    (Module["_FPDFLink_GetLinkAtPoint"] =
      makeInvalidEarlyAccess("_FPDFLink_GetLinkAtPoint"));
    (Module["_FPDFLink_GetLinkZOrderAtPoint"] = makeInvalidEarlyAccess(
      "_FPDFLink_GetLinkZOrderAtPoint",
    ));
    (Module["_FPDFLink_GetDest"] = makeInvalidEarlyAccess("_FPDFLink_GetDest"));
    (Module["_FPDFLink_GetAction"] = makeInvalidEarlyAccess("_FPDFLink_GetAction"));
    (Module["_FPDFLink_Enumerate"] = makeInvalidEarlyAccess("_FPDFLink_Enumerate"));
    (Module["_FPDFLink_GetAnnot"] = makeInvalidEarlyAccess("_FPDFLink_GetAnnot"));
    (Module["_FPDFLink_GetAnnotRect"] = makeInvalidEarlyAccess("_FPDFLink_GetAnnotRect"));
    (Module["_FPDFLink_CountQuadPoints"] =
      makeInvalidEarlyAccess("_FPDFLink_CountQuadPoints"));
    (Module["_FPDFLink_GetQuadPoints"] =
      makeInvalidEarlyAccess("_FPDFLink_GetQuadPoints"));
    (Module["_FPDF_GetPageAAction"] = makeInvalidEarlyAccess("_FPDF_GetPageAAction"));
    (Module["_FPDF_GetFileIdentifier"] =
      makeInvalidEarlyAccess("_FPDF_GetFileIdentifier"));
    (Module["_FPDF_GetMetaText"] = makeInvalidEarlyAccess("_FPDF_GetMetaText"));
    (Module["_FPDF_GetPageLabel"] = makeInvalidEarlyAccess("_FPDF_GetPageLabel"));
    (Module["_FPDFPageObj_NewImageObj"] =
      makeInvalidEarlyAccess("_FPDFPageObj_NewImageObj"));
    (Module["_FPDFImageObj_LoadJpegFile"] =
      makeInvalidEarlyAccess("_FPDFImageObj_LoadJpegFile"));
    (Module["_FPDFImageObj_LoadJpegFileInline"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_LoadJpegFileInline",
    ));
    (Module["_FPDFImageObj_SetMatrix"] =
      makeInvalidEarlyAccess("_FPDFImageObj_SetMatrix"));
    (Module["_FPDFImageObj_SetBitmap"] =
      makeInvalidEarlyAccess("_FPDFImageObj_SetBitmap"));
    (Module["_FPDFImageObj_GetBitmap"] =
      makeInvalidEarlyAccess("_FPDFImageObj_GetBitmap"));
    (Module["_FPDFImageObj_GetRenderedBitmap"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetRenderedBitmap",
    ));
    (Module["_FPDFImageObj_GetImageDataDecoded"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetImageDataDecoded",
    ));
    (Module["_FPDFImageObj_GetImageDataRaw"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetImageDataRaw",
    ));
    (Module["_FPDFImageObj_GetImageFilterCount"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetImageFilterCount",
    ));
    (Module["_FPDFImageObj_GetImageFilter"] =
      makeInvalidEarlyAccess("_FPDFImageObj_GetImageFilter"));
    (Module["_FPDFImageObj_GetImageMetadata"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetImageMetadata",
    ));
    (Module["_FPDFImageObj_GetImagePixelSize"] = makeInvalidEarlyAccess(
      "_FPDFImageObj_GetImagePixelSize",
    ));
    (Module["_FPDFImageObj_GetIccProfileDataDecoded"] =
      makeInvalidEarlyAccess("_FPDFImageObj_GetIccProfileDataDecoded"));
    (Module["_FPDF_CreateNewDocument"] =
      makeInvalidEarlyAccess("_FPDF_CreateNewDocument"));
    (Module["_FPDFPage_Delete"] = makeInvalidEarlyAccess("_FPDFPage_Delete"));
    (Module["_FPDF_MovePages"] = makeInvalidEarlyAccess("_FPDF_MovePages"));
    (Module["_FPDFPage_New"] = makeInvalidEarlyAccess("_FPDFPage_New"));
    (Module["_FPDFPage_GetRotation"] = makeInvalidEarlyAccess("_FPDFPage_GetRotation"));
    (Module["_FPDFPage_InsertObject"] = makeInvalidEarlyAccess("_FPDFPage_InsertObject"));
    (Module["_FPDFPage_InsertObjectAtIndex"] = makeInvalidEarlyAccess(
      "_FPDFPage_InsertObjectAtIndex",
    ));
    (Module["_FPDFPage_RemoveObject"] = makeInvalidEarlyAccess("_FPDFPage_RemoveObject"));
    (Module["_FPDFPage_CountObjects"] = makeInvalidEarlyAccess("_FPDFPage_CountObjects"));
    (Module["_FPDFPage_GetObject"] = makeInvalidEarlyAccess("_FPDFPage_GetObject"));
    (Module["_FPDFPage_HasTransparency"] =
      makeInvalidEarlyAccess("_FPDFPage_HasTransparency"));
    (Module["_FPDFPageObj_Destroy"] = makeInvalidEarlyAccess("_FPDFPageObj_Destroy"));
    (Module["_FPDFPageObj_GetMarkedContentID"] = makeInvalidEarlyAccess(
      "_FPDFPageObj_GetMarkedContentID",
    ));
    (Module["_FPDFPageObj_CountMarks"] =
      makeInvalidEarlyAccess("_FPDFPageObj_CountMarks"));
    (Module["_FPDFPageObj_GetMark"] = makeInvalidEarlyAccess("_FPDFPageObj_GetMark"));
    (Module["_FPDFPageObj_AddMark"] = makeInvalidEarlyAccess("_FPDFPageObj_AddMark"));
    (Module["_FPDFPageObj_RemoveMark"] =
      makeInvalidEarlyAccess("_FPDFPageObj_RemoveMark"));
    (Module["_FPDFPageObjMark_GetName"] =
      makeInvalidEarlyAccess("_FPDFPageObjMark_GetName"));
    (Module["_FPDFPageObjMark_CountParams"] =
      makeInvalidEarlyAccess("_FPDFPageObjMark_CountParams"));
    (Module["_FPDFPageObjMark_GetParamKey"] =
      makeInvalidEarlyAccess("_FPDFPageObjMark_GetParamKey"));
    (Module["_FPDFPageObjMark_GetParamValueType"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_GetParamValueType",
    ));
    (Module["_FPDFPageObjMark_GetParamIntValue"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_GetParamIntValue",
    ));
    (Module["_FPDFPageObjMark_GetParamStringValue"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_GetParamStringValue",
    ));
    (Module["_FPDFPageObjMark_GetParamBlobValue"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_GetParamBlobValue",
    ));
    (Module["_FPDFPageObj_HasTransparency"] =
      makeInvalidEarlyAccess("_FPDFPageObj_HasTransparency"));
    (Module["_FPDFPageObjMark_SetIntParam"] =
      makeInvalidEarlyAccess("_FPDFPageObjMark_SetIntParam"));
    (Module["_FPDFPageObjMark_SetStringParam"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_SetStringParam",
    ));
    (Module["_FPDFPageObjMark_SetBlobParam"] = makeInvalidEarlyAccess(
      "_FPDFPageObjMark_SetBlobParam",
    ));
    (Module["_FPDFPageObjMark_RemoveParam"] =
      makeInvalidEarlyAccess("_FPDFPageObjMark_RemoveParam"));
    (Module["_FPDFPageObj_GetType"] = makeInvalidEarlyAccess("_FPDFPageObj_GetType"));
    (Module["_FPDFPageObj_GetIsActive"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetIsActive"));
    (Module["_FPDFPageObj_SetIsActive"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetIsActive"));
    (Module["_FPDFPage_GenerateContent"] =
      makeInvalidEarlyAccess("_FPDFPage_GenerateContent"));
    (Module["_FPDFPageObj_Transform"] = makeInvalidEarlyAccess("_FPDFPageObj_Transform"));
    (Module["_FPDFPageObj_TransformF"] =
      makeInvalidEarlyAccess("_FPDFPageObj_TransformF"));
    (Module["_FPDFPageObj_GetMatrix"] = makeInvalidEarlyAccess("_FPDFPageObj_GetMatrix"));
    (Module["_FPDFPageObj_SetMatrix"] = makeInvalidEarlyAccess("_FPDFPageObj_SetMatrix"));
    (Module["_FPDFPageObj_SetBlendMode"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetBlendMode"));
    (Module["_FPDFPage_TransformAnnots"] =
      makeInvalidEarlyAccess("_FPDFPage_TransformAnnots"));
    (Module["_FPDFPage_SetRotation"] = makeInvalidEarlyAccess("_FPDFPage_SetRotation"));
    (Module["_FPDFPageObj_SetFillColor"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetFillColor"));
    (Module["_FPDFPageObj_GetFillColor"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetFillColor"));
    (Module["_FPDFPageObj_GetBounds"] = makeInvalidEarlyAccess("_FPDFPageObj_GetBounds"));
    (Module["_FPDFPageObj_GetRotatedBounds"] = makeInvalidEarlyAccess(
      "_FPDFPageObj_GetRotatedBounds",
    ));
    (Module["_FPDFPageObj_SetStrokeColor"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetStrokeColor"));
    (Module["_FPDFPageObj_GetStrokeColor"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetStrokeColor"));
    (Module["_FPDFPageObj_SetStrokeWidth"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetStrokeWidth"));
    (Module["_FPDFPageObj_GetStrokeWidth"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetStrokeWidth"));
    (Module["_FPDFPageObj_GetLineJoin"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetLineJoin"));
    (Module["_FPDFPageObj_SetLineJoin"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetLineJoin"));
    (Module["_FPDFPageObj_GetLineCap"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetLineCap"));
    (Module["_FPDFPageObj_SetLineCap"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetLineCap"));
    (Module["_FPDFPageObj_GetDashPhase"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetDashPhase"));
    (Module["_FPDFPageObj_SetDashPhase"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetDashPhase"));
    (Module["_FPDFPageObj_GetDashCount"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetDashCount"));
    (Module["_FPDFPageObj_GetDashArray"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetDashArray"));
    (Module["_FPDFPageObj_SetDashArray"] =
      makeInvalidEarlyAccess("_FPDFPageObj_SetDashArray"));
    (Module["_FPDFFormObj_CountObjects"] =
      makeInvalidEarlyAccess("_FPDFFormObj_CountObjects"));
    (Module["_FPDFFormObj_GetObject"] = makeInvalidEarlyAccess("_FPDFFormObj_GetObject"));
    (Module["_FPDFFormObj_RemoveObject"] =
      makeInvalidEarlyAccess("_FPDFFormObj_RemoveObject"));
    (Module["_FPDFPageObj_CreateNewPath"] =
      makeInvalidEarlyAccess("_FPDFPageObj_CreateNewPath"));
    (Module["_FPDFPageObj_CreateNewRect"] =
      makeInvalidEarlyAccess("_FPDFPageObj_CreateNewRect"));
    (Module["_FPDFPath_CountSegments"] =
      makeInvalidEarlyAccess("_FPDFPath_CountSegments"));
    (Module["_FPDFPath_GetPathSegment"] =
      makeInvalidEarlyAccess("_FPDFPath_GetPathSegment"));
    (Module["_FPDFPath_MoveTo"] = makeInvalidEarlyAccess("_FPDFPath_MoveTo"));
    (Module["_FPDFPath_LineTo"] = makeInvalidEarlyAccess("_FPDFPath_LineTo"));
    (Module["_FPDFPath_BezierTo"] = makeInvalidEarlyAccess("_FPDFPath_BezierTo"));
    (Module["_FPDFPath_Close"] = makeInvalidEarlyAccess("_FPDFPath_Close"));
    (Module["_FPDFPath_SetDrawMode"] = makeInvalidEarlyAccess("_FPDFPath_SetDrawMode"));
    (Module["_FPDFPath_GetDrawMode"] = makeInvalidEarlyAccess("_FPDFPath_GetDrawMode"));
    (Module["_FPDFPathSegment_GetPoint"] =
      makeInvalidEarlyAccess("_FPDFPathSegment_GetPoint"));
    (Module["_FPDFPathSegment_GetType"] =
      makeInvalidEarlyAccess("_FPDFPathSegment_GetType"));
    (Module["_FPDFPathSegment_GetClose"] =
      makeInvalidEarlyAccess("_FPDFPathSegment_GetClose"));
    (Module["_FPDFPageObj_NewTextObj"] =
      makeInvalidEarlyAccess("_FPDFPageObj_NewTextObj"));
    (Module["_FPDFText_SetText"] = makeInvalidEarlyAccess("_FPDFText_SetText"));
    (Module["_FPDFText_SetCharcodes"] = makeInvalidEarlyAccess("_FPDFText_SetCharcodes"));
    (Module["_FPDFText_LoadFont"] = makeInvalidEarlyAccess("_FPDFText_LoadFont"));
    (Module["_FPDFText_LoadStandardFont"] =
      makeInvalidEarlyAccess("_FPDFText_LoadStandardFont"));
    (Module["_FPDFText_LoadCidType2Font"] =
      makeInvalidEarlyAccess("_FPDFText_LoadCidType2Font"));
    (Module["_FPDFTextObj_GetFontSize"] =
      makeInvalidEarlyAccess("_FPDFTextObj_GetFontSize"));
    (Module["_FPDFTextObj_GetText"] = makeInvalidEarlyAccess("_FPDFTextObj_GetText"));
    (Module["_FPDFTextObj_GetRenderedBitmap"] = makeInvalidEarlyAccess(
      "_FPDFTextObj_GetRenderedBitmap",
    ));
    (Module["_FPDFFont_Close"] = makeInvalidEarlyAccess("_FPDFFont_Close"));
    (Module["_FPDFPageObj_CreateTextObj"] =
      makeInvalidEarlyAccess("_FPDFPageObj_CreateTextObj"));
    (Module["_FPDFTextObj_GetTextRenderMode"] = makeInvalidEarlyAccess(
      "_FPDFTextObj_GetTextRenderMode",
    ));
    (Module["_FPDFTextObj_SetTextRenderMode"] = makeInvalidEarlyAccess(
      "_FPDFTextObj_SetTextRenderMode",
    ));
    (Module["_FPDFTextObj_GetFont"] = makeInvalidEarlyAccess("_FPDFTextObj_GetFont"));
    (Module["_FPDFFont_GetBaseFontName"] =
      makeInvalidEarlyAccess("_FPDFFont_GetBaseFontName"));
    (Module["_FPDFFont_GetFamilyName"] =
      makeInvalidEarlyAccess("_FPDFFont_GetFamilyName"));
    (Module["_FPDFFont_GetFontData"] = makeInvalidEarlyAccess("_FPDFFont_GetFontData"));
    (Module["_FPDFFont_GetIsEmbedded"] =
      makeInvalidEarlyAccess("_FPDFFont_GetIsEmbedded"));
    (Module["_FPDFFont_GetFlags"] = makeInvalidEarlyAccess("_FPDFFont_GetFlags"));
    (Module["_FPDFFont_GetWeight"] = makeInvalidEarlyAccess("_FPDFFont_GetWeight"));
    (Module["_FPDFFont_GetItalicAngle"] =
      makeInvalidEarlyAccess("_FPDFFont_GetItalicAngle"));
    (Module["_FPDFFont_GetAscent"] = makeInvalidEarlyAccess("_FPDFFont_GetAscent"));
    (Module["_FPDFFont_GetDescent"] = makeInvalidEarlyAccess("_FPDFFont_GetDescent"));
    (Module["_FPDFFont_GetGlyphWidth"] =
      makeInvalidEarlyAccess("_FPDFFont_GetGlyphWidth"));
    (Module["_FPDFFont_GetGlyphPath"] = makeInvalidEarlyAccess("_FPDFFont_GetGlyphPath"));
    (Module["_FPDFGlyphPath_CountGlyphSegments"] = makeInvalidEarlyAccess(
      "_FPDFGlyphPath_CountGlyphSegments",
    ));
    (Module["_FPDFGlyphPath_GetGlyphPathSegment"] = makeInvalidEarlyAccess(
      "_FPDFGlyphPath_GetGlyphPathSegment",
    ));
    (Module["_FSDK_SetUnSpObjProcessHandler"] = makeInvalidEarlyAccess(
      "_FSDK_SetUnSpObjProcessHandler",
    ));
    (Module["_FSDK_SetTimeFunction"] = makeInvalidEarlyAccess("_FSDK_SetTimeFunction"));
    (Module["_FSDK_SetLocaltimeFunction"] =
      makeInvalidEarlyAccess("_FSDK_SetLocaltimeFunction"));
    (Module["_FPDFDoc_GetPageMode"] = makeInvalidEarlyAccess("_FPDFDoc_GetPageMode"));
    (Module["_FPDFPage_Flatten"] = makeInvalidEarlyAccess("_FPDFPage_Flatten"));
    (Module["_FPDFPage_HasFormFieldAtPoint"] = makeInvalidEarlyAccess(
      "_FPDFPage_HasFormFieldAtPoint",
    ));
    (Module["_FPDFPage_FormFieldZOrderAtPoint"] = makeInvalidEarlyAccess(
      "_FPDFPage_FormFieldZOrderAtPoint",
    ));
    (Module["_FPDFDOC_InitFormFillEnvironment"] = makeInvalidEarlyAccess(
      "_FPDFDOC_InitFormFillEnvironment",
    ));
    (Module["_FPDFDOC_ExitFormFillEnvironment"] = makeInvalidEarlyAccess(
      "_FPDFDOC_ExitFormFillEnvironment",
    ));
    (Module["_FORM_OnMouseMove"] = makeInvalidEarlyAccess("_FORM_OnMouseMove"));
    (Module["_FORM_OnMouseWheel"] = makeInvalidEarlyAccess("_FORM_OnMouseWheel"));
    (Module["_FORM_OnFocus"] = makeInvalidEarlyAccess("_FORM_OnFocus"));
    (Module["_FORM_OnLButtonDown"] = makeInvalidEarlyAccess("_FORM_OnLButtonDown"));
    (Module["_FORM_OnLButtonUp"] = makeInvalidEarlyAccess("_FORM_OnLButtonUp"));
    (Module["_FORM_OnLButtonDoubleClick"] =
      makeInvalidEarlyAccess("_FORM_OnLButtonDoubleClick"));
    (Module["_FORM_OnRButtonDown"] = makeInvalidEarlyAccess("_FORM_OnRButtonDown"));
    (Module["_FORM_OnRButtonUp"] = makeInvalidEarlyAccess("_FORM_OnRButtonUp"));
    (Module["_FORM_OnKeyDown"] = makeInvalidEarlyAccess("_FORM_OnKeyDown"));
    (Module["_FORM_OnKeyUp"] = makeInvalidEarlyAccess("_FORM_OnKeyUp"));
    (Module["_FORM_OnChar"] = makeInvalidEarlyAccess("_FORM_OnChar"));
    (Module["_FORM_GetFocusedText"] = makeInvalidEarlyAccess("_FORM_GetFocusedText"));
    (Module["_FORM_GetSelectedText"] = makeInvalidEarlyAccess("_FORM_GetSelectedText"));
    (Module["_FORM_ReplaceAndKeepSelection"] = makeInvalidEarlyAccess(
      "_FORM_ReplaceAndKeepSelection",
    ));
    (Module["_FORM_ReplaceSelection"] = makeInvalidEarlyAccess("_FORM_ReplaceSelection"));
    (Module["_FORM_SelectAllText"] = makeInvalidEarlyAccess("_FORM_SelectAllText"));
    (Module["_FORM_CanUndo"] = makeInvalidEarlyAccess("_FORM_CanUndo"));
    (Module["_FORM_CanRedo"] = makeInvalidEarlyAccess("_FORM_CanRedo"));
    (Module["_FORM_Undo"] = makeInvalidEarlyAccess("_FORM_Undo"));
    (Module["_FORM_Redo"] = makeInvalidEarlyAccess("_FORM_Redo"));
    (Module["_FORM_ForceToKillFocus"] = makeInvalidEarlyAccess("_FORM_ForceToKillFocus"));
    (Module["_FORM_GetFocusedAnnot"] = makeInvalidEarlyAccess("_FORM_GetFocusedAnnot"));
    (Module["_FORM_SetFocusedAnnot"] = makeInvalidEarlyAccess("_FORM_SetFocusedAnnot"));
    (Module["_FPDF_FFLDraw"] = makeInvalidEarlyAccess("_FPDF_FFLDraw"));
    (Module["_FPDF_SetFormFieldHighlightColor"] = makeInvalidEarlyAccess(
      "_FPDF_SetFormFieldHighlightColor",
    ));
    (Module["_FPDF_SetFormFieldHighlightAlpha"] = makeInvalidEarlyAccess(
      "_FPDF_SetFormFieldHighlightAlpha",
    ));
    (Module["_FPDF_RemoveFormFieldHighlight"] = makeInvalidEarlyAccess(
      "_FPDF_RemoveFormFieldHighlight",
    ));
    (Module["_FORM_OnAfterLoadPage"] = makeInvalidEarlyAccess("_FORM_OnAfterLoadPage"));
    (Module["_FORM_OnBeforeClosePage"] =
      makeInvalidEarlyAccess("_FORM_OnBeforeClosePage"));
    (Module["_FORM_DoDocumentJSAction"] =
      makeInvalidEarlyAccess("_FORM_DoDocumentJSAction"));
    (Module["_FORM_DoDocumentOpenAction"] =
      makeInvalidEarlyAccess("_FORM_DoDocumentOpenAction"));
    (Module["_FORM_DoDocumentAAction"] =
      makeInvalidEarlyAccess("_FORM_DoDocumentAAction"));
    (Module["_FORM_DoPageAAction"] = makeInvalidEarlyAccess("_FORM_DoPageAAction"));
    (Module["_FORM_SetIndexSelected"] = makeInvalidEarlyAccess("_FORM_SetIndexSelected"));
    (Module["_FORM_IsIndexSelected"] = makeInvalidEarlyAccess("_FORM_IsIndexSelected"));
    (Module["_FPDFDoc_GetJavaScriptActionCount"] = makeInvalidEarlyAccess(
      "_FPDFDoc_GetJavaScriptActionCount",
    ));
    (Module["_FPDFDoc_GetJavaScriptAction"] =
      makeInvalidEarlyAccess("_FPDFDoc_GetJavaScriptAction"));
    (Module["_FPDFDoc_CloseJavaScriptAction"] = makeInvalidEarlyAccess(
      "_FPDFDoc_CloseJavaScriptAction",
    ));
    (Module["_FPDFJavaScriptAction_GetName"] = makeInvalidEarlyAccess(
      "_FPDFJavaScriptAction_GetName",
    ));
    (Module["_FPDFJavaScriptAction_GetScript"] = makeInvalidEarlyAccess(
      "_FPDFJavaScriptAction_GetScript",
    ));
    (Module["_FPDF_ImportPagesByIndex"] =
      makeInvalidEarlyAccess("_FPDF_ImportPagesByIndex"));
    (Module["_FPDF_ImportPages"] = makeInvalidEarlyAccess("_FPDF_ImportPages"));
    (Module["_FPDF_ImportNPagesToOne"] =
      makeInvalidEarlyAccess("_FPDF_ImportNPagesToOne"));
    (Module["_FPDF_NewXObjectFromPage"] =
      makeInvalidEarlyAccess("_FPDF_NewXObjectFromPage"));
    (Module["_FPDF_CloseXObject"] = makeInvalidEarlyAccess("_FPDF_CloseXObject"));
    (Module["_FPDF_NewFormObjectFromXObject"] = makeInvalidEarlyAccess(
      "_FPDF_NewFormObjectFromXObject",
    ));
    (Module["_FPDF_CopyViewerPreferences"] =
      makeInvalidEarlyAccess("_FPDF_CopyViewerPreferences"));
    (Module["_FPDF_RenderPageBitmapWithColorScheme_Start"] =
      makeInvalidEarlyAccess("_FPDF_RenderPageBitmapWithColorScheme_Start"));
    (Module["_FPDF_RenderPageBitmap_Start"] =
      makeInvalidEarlyAccess("_FPDF_RenderPageBitmap_Start"));
    (Module["_FPDF_RenderPage_Continue"] =
      makeInvalidEarlyAccess("_FPDF_RenderPage_Continue"));
    (Module["_FPDF_RenderPage_Close"] = makeInvalidEarlyAccess("_FPDF_RenderPage_Close"));
    (Module["_FPDF_SaveAsCopy"] = makeInvalidEarlyAccess("_FPDF_SaveAsCopy"));
    (Module["_FPDF_SaveWithVersion"] = makeInvalidEarlyAccess("_FPDF_SaveWithVersion"));
    (Module["_FPDFText_GetCharIndexFromTextIndex"] = makeInvalidEarlyAccess(
      "_FPDFText_GetCharIndexFromTextIndex",
    ));
    (Module["_FPDFText_GetTextIndexFromCharIndex"] = makeInvalidEarlyAccess(
      "_FPDFText_GetTextIndexFromCharIndex",
    ));
    (Module["_FPDF_GetSignatureCount"] =
      makeInvalidEarlyAccess("_FPDF_GetSignatureCount"));
    (Module["_FPDF_GetSignatureObject"] =
      makeInvalidEarlyAccess("_FPDF_GetSignatureObject"));
    (Module["_FPDFSignatureObj_GetContents"] = makeInvalidEarlyAccess(
      "_FPDFSignatureObj_GetContents",
    ));
    (Module["_FPDFSignatureObj_GetByteRange"] = makeInvalidEarlyAccess(
      "_FPDFSignatureObj_GetByteRange",
    ));
    (Module["_FPDFSignatureObj_GetSubFilter"] = makeInvalidEarlyAccess(
      "_FPDFSignatureObj_GetSubFilter",
    ));
    (Module["_FPDFSignatureObj_GetReason"] =
      makeInvalidEarlyAccess("_FPDFSignatureObj_GetReason"));
    (Module["_FPDFSignatureObj_GetTime"] =
      makeInvalidEarlyAccess("_FPDFSignatureObj_GetTime"));
    (Module["_FPDFSignatureObj_GetDocMDPPermission"] =
      makeInvalidEarlyAccess("_FPDFSignatureObj_GetDocMDPPermission"));
    (Module["_FPDF_StructTree_GetForPage"] =
      makeInvalidEarlyAccess("_FPDF_StructTree_GetForPage"));
    (Module["_FPDF_StructTree_Close"] = makeInvalidEarlyAccess("_FPDF_StructTree_Close"));
    (Module["_FPDF_StructTree_CountChildren"] = makeInvalidEarlyAccess(
      "_FPDF_StructTree_CountChildren",
    ));
    (Module["_FPDF_StructTree_GetChildAtIndex"] = makeInvalidEarlyAccess(
      "_FPDF_StructTree_GetChildAtIndex",
    ));
    (Module["_FPDF_StructElement_GetAltText"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_GetAltText",
    ));
    (Module["_FPDF_StructElement_GetActualText"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_GetActualText",
    ));
    (Module["_FPDF_StructElement_GetID"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetID"));
    (Module["_FPDF_StructElement_GetLang"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetLang"));
    (Module["_FPDF_StructElement_GetAttributeCount"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetAttributeCount"));
    (Module["_FPDF_StructElement_GetAttributeAtIndex"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetAttributeAtIndex"));
    (Module["_FPDF_StructElement_GetStringAttribute"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetStringAttribute"));
    (Module["_FPDF_StructElement_GetMarkedContentID"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetMarkedContentID"));
    (Module["_FPDF_StructElement_GetType"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetType"));
    (Module["_FPDF_StructElement_GetObjType"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_GetObjType",
    ));
    (Module["_FPDF_StructElement_GetTitle"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetTitle"));
    (Module["_FPDF_StructElement_CountChildren"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_CountChildren",
    ));
    (Module["_FPDF_StructElement_GetChildAtIndex"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_GetChildAtIndex",
    ));
    (Module["_FPDF_StructElement_GetChildMarkedContentID"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetChildMarkedContentID"));
    (Module["_FPDF_StructElement_GetParent"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_GetParent",
    ));
    (Module["_FPDF_StructElement_Attr_GetCount"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_Attr_GetCount",
    ));
    (Module["_FPDF_StructElement_Attr_GetName"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_Attr_GetName",
    ));
    (Module["_FPDF_StructElement_Attr_GetValue"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_Attr_GetValue",
    ));
    (Module["_FPDF_StructElement_Attr_GetType"] = makeInvalidEarlyAccess(
      "_FPDF_StructElement_Attr_GetType",
    ));
    (Module["_FPDF_StructElement_Attr_GetBooleanValue"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_GetBooleanValue"));
    (Module["_FPDF_StructElement_Attr_GetNumberValue"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_GetNumberValue"));
    (Module["_FPDF_StructElement_Attr_GetStringValue"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_GetStringValue"));
    (Module["_FPDF_StructElement_Attr_GetBlobValue"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_GetBlobValue"));
    (Module["_FPDF_StructElement_Attr_CountChildren"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_CountChildren"));
    (Module["_FPDF_StructElement_Attr_GetChildAtIndex"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_Attr_GetChildAtIndex"));
    (Module["_FPDF_StructElement_GetMarkedContentIdCount"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetMarkedContentIdCount"));
    (Module["_FPDF_StructElement_GetMarkedContentIdAtIndex"] =
      makeInvalidEarlyAccess("_FPDF_StructElement_GetMarkedContentIdAtIndex"));
    (Module["_FPDF_AddInstalledFont"] = makeInvalidEarlyAccess("_FPDF_AddInstalledFont"));
    (Module["_FPDF_SetSystemFontInfo"] =
      makeInvalidEarlyAccess("_FPDF_SetSystemFontInfo"));
    (Module["_FPDF_GetDefaultTTFMap"] = makeInvalidEarlyAccess("_FPDF_GetDefaultTTFMap"));
    (Module["_FPDF_GetDefaultTTFMapCount"] =
      makeInvalidEarlyAccess("_FPDF_GetDefaultTTFMapCount"));
    (Module["_FPDF_GetDefaultTTFMapEntry"] =
      makeInvalidEarlyAccess("_FPDF_GetDefaultTTFMapEntry"));
    (Module["_FPDF_GetDefaultSystemFontInfo"] = makeInvalidEarlyAccess(
      "_FPDF_GetDefaultSystemFontInfo",
    ));
    (Module["_FPDF_FreeDefaultSystemFontInfo"] = makeInvalidEarlyAccess(
      "_FPDF_FreeDefaultSystemFontInfo",
    ));
    (Module["_FPDFText_LoadPage"] = makeInvalidEarlyAccess("_FPDFText_LoadPage"));
    (Module["_FPDFText_ClosePage"] = makeInvalidEarlyAccess("_FPDFText_ClosePage"));
    (Module["_FPDFText_CountChars"] = makeInvalidEarlyAccess("_FPDFText_CountChars"));
    (Module["_FPDFText_GetUnicode"] = makeInvalidEarlyAccess("_FPDFText_GetUnicode"));
    (Module["_FPDFText_GetTextObject"] =
      makeInvalidEarlyAccess("_FPDFText_GetTextObject"));
    (Module["_FPDFText_IsGenerated"] = makeInvalidEarlyAccess("_FPDFText_IsGenerated"));
    (Module["_FPDFText_IsHyphen"] = makeInvalidEarlyAccess("_FPDFText_IsHyphen"));
    (Module["_FPDFText_HasUnicodeMapError"] =
      makeInvalidEarlyAccess("_FPDFText_HasUnicodeMapError"));
    (Module["_FPDFText_GetFontSize"] = makeInvalidEarlyAccess("_FPDFText_GetFontSize"));
    (Module["_FPDFText_GetFontInfo"] = makeInvalidEarlyAccess("_FPDFText_GetFontInfo"));
    (Module["_FPDFText_GetFontWeight"] =
      makeInvalidEarlyAccess("_FPDFText_GetFontWeight"));
    (Module["_FPDFText_GetFillColor"] = makeInvalidEarlyAccess("_FPDFText_GetFillColor"));
    (Module["_FPDFText_GetStrokeColor"] =
      makeInvalidEarlyAccess("_FPDFText_GetStrokeColor"));
    (Module["_FPDFText_GetCharAngle"] = makeInvalidEarlyAccess("_FPDFText_GetCharAngle"));
    (Module["_FPDFText_GetCharBox"] = makeInvalidEarlyAccess("_FPDFText_GetCharBox"));
    (Module["_FPDFText_GetLooseCharBox"] =
      makeInvalidEarlyAccess("_FPDFText_GetLooseCharBox"));
    (Module["_FPDFText_GetMatrix"] = makeInvalidEarlyAccess("_FPDFText_GetMatrix"));
    (Module["_FPDFText_GetCharOrigin"] =
      makeInvalidEarlyAccess("_FPDFText_GetCharOrigin"));
    (Module["_FPDFText_GetCharIndexAtPos"] =
      makeInvalidEarlyAccess("_FPDFText_GetCharIndexAtPos"));
    (Module["_FPDFText_GetText"] = makeInvalidEarlyAccess("_FPDFText_GetText"));
    (Module["_FPDFText_CountRects"] = makeInvalidEarlyAccess("_FPDFText_CountRects"));
    (Module["_FPDFText_GetRect"] = makeInvalidEarlyAccess("_FPDFText_GetRect"));
    (Module["_FPDFText_GetBoundedText"] =
      makeInvalidEarlyAccess("_FPDFText_GetBoundedText"));
    (Module["_FPDFText_FindStart"] = makeInvalidEarlyAccess("_FPDFText_FindStart"));
    (Module["_FPDFText_FindNext"] = makeInvalidEarlyAccess("_FPDFText_FindNext"));
    (Module["_FPDFText_FindPrev"] = makeInvalidEarlyAccess("_FPDFText_FindPrev"));
    (Module["_FPDFText_GetSchResultIndex"] =
      makeInvalidEarlyAccess("_FPDFText_GetSchResultIndex"));
    (Module["_FPDFText_GetSchCount"] = makeInvalidEarlyAccess("_FPDFText_GetSchCount"));
    (Module["_FPDFText_FindClose"] = makeInvalidEarlyAccess("_FPDFText_FindClose"));
    (Module["_FPDFLink_LoadWebLinks"] = makeInvalidEarlyAccess("_FPDFLink_LoadWebLinks"));
    (Module["_FPDFLink_CountWebLinks"] =
      makeInvalidEarlyAccess("_FPDFLink_CountWebLinks"));
    (Module["_FPDFLink_GetURL"] = makeInvalidEarlyAccess("_FPDFLink_GetURL"));
    (Module["_FPDFLink_CountRects"] = makeInvalidEarlyAccess("_FPDFLink_CountRects"));
    (Module["_FPDFLink_GetRect"] = makeInvalidEarlyAccess("_FPDFLink_GetRect"));
    (Module["_FPDFLink_GetTextRange"] = makeInvalidEarlyAccess("_FPDFLink_GetTextRange"));
    (Module["_FPDFLink_CloseWebLinks"] =
      makeInvalidEarlyAccess("_FPDFLink_CloseWebLinks"));
    (Module["_FPDFPage_GetDecodedThumbnailData"] = makeInvalidEarlyAccess(
      "_FPDFPage_GetDecodedThumbnailData",
    ));
    (Module["_FPDFPage_GetRawThumbnailData"] = makeInvalidEarlyAccess(
      "_FPDFPage_GetRawThumbnailData",
    ));
    (Module["_FPDFPage_GetThumbnailAsBitmap"] = makeInvalidEarlyAccess(
      "_FPDFPage_GetThumbnailAsBitmap",
    ));
    (Module["_FPDFPage_SetMediaBox"] = makeInvalidEarlyAccess("_FPDFPage_SetMediaBox"));
    (Module["_FPDFPage_SetCropBox"] = makeInvalidEarlyAccess("_FPDFPage_SetCropBox"));
    (Module["_FPDFPage_SetBleedBox"] = makeInvalidEarlyAccess("_FPDFPage_SetBleedBox"));
    (Module["_FPDFPage_SetTrimBox"] = makeInvalidEarlyAccess("_FPDFPage_SetTrimBox"));
    (Module["_FPDFPage_SetArtBox"] = makeInvalidEarlyAccess("_FPDFPage_SetArtBox"));
    (Module["_FPDFPage_GetMediaBox"] = makeInvalidEarlyAccess("_FPDFPage_GetMediaBox"));
    (Module["_FPDFPage_GetCropBox"] = makeInvalidEarlyAccess("_FPDFPage_GetCropBox"));
    (Module["_FPDFPage_GetBleedBox"] = makeInvalidEarlyAccess("_FPDFPage_GetBleedBox"));
    (Module["_FPDFPage_GetTrimBox"] = makeInvalidEarlyAccess("_FPDFPage_GetTrimBox"));
    (Module["_FPDFPage_GetArtBox"] = makeInvalidEarlyAccess("_FPDFPage_GetArtBox"));
    (Module["_FPDFPage_TransFormWithClip"] =
      makeInvalidEarlyAccess("_FPDFPage_TransFormWithClip"));
    (Module["_FPDFPageObj_TransformClipPath"] = makeInvalidEarlyAccess(
      "_FPDFPageObj_TransformClipPath",
    ));
    (Module["_FPDFPageObj_GetClipPath"] =
      makeInvalidEarlyAccess("_FPDFPageObj_GetClipPath"));
    (Module["_FPDFClipPath_CountPaths"] =
      makeInvalidEarlyAccess("_FPDFClipPath_CountPaths"));
    (Module["_FPDFClipPath_CountPathSegments"] = makeInvalidEarlyAccess(
      "_FPDFClipPath_CountPathSegments",
    ));
    (Module["_FPDFClipPath_GetPathSegment"] =
      makeInvalidEarlyAccess("_FPDFClipPath_GetPathSegment"));
    (Module["_FPDF_CreateClipPath"] = makeInvalidEarlyAccess("_FPDF_CreateClipPath"));
    (Module["_FPDF_DestroyClipPath"] = makeInvalidEarlyAccess("_FPDF_DestroyClipPath"));
    (Module["_FPDFPage_InsertClipPath"] =
      makeInvalidEarlyAccess("_FPDFPage_InsertClipPath"));
    (Module["_FPDF_InitLibrary"] = makeInvalidEarlyAccess("_FPDF_InitLibrary"));
    (Module["_malloc"] = makeInvalidEarlyAccess("_malloc"));
    (Module["_free"] = makeInvalidEarlyAccess("_free"));
    (Module["_FPDF_DestroyLibrary"] = makeInvalidEarlyAccess("_FPDF_DestroyLibrary"));
    (Module["_FPDF_SetSandBoxPolicy"] = makeInvalidEarlyAccess("_FPDF_SetSandBoxPolicy"));
    (Module["_FPDF_LoadDocument"] = makeInvalidEarlyAccess("_FPDF_LoadDocument"));
    (Module["_FPDF_GetFormType"] = makeInvalidEarlyAccess("_FPDF_GetFormType"));
    (Module["_FPDF_LoadXFA"] = makeInvalidEarlyAccess("_FPDF_LoadXFA"));
    (Module["_FPDF_LoadMemDocument"] = makeInvalidEarlyAccess("_FPDF_LoadMemDocument"));
    (Module["_FPDF_LoadMemDocument64"] =
      makeInvalidEarlyAccess("_FPDF_LoadMemDocument64"));
    (Module["_FPDF_LoadCustomDocument"] =
      makeInvalidEarlyAccess("_FPDF_LoadCustomDocument"));
    (Module["_FPDF_GetFileVersion"] = makeInvalidEarlyAccess("_FPDF_GetFileVersion"));
    (Module["_FPDF_DocumentHasValidCrossReferenceTable"] =
      makeInvalidEarlyAccess("_FPDF_DocumentHasValidCrossReferenceTable"));
    (Module["_FPDF_GetDocPermissions"] =
      makeInvalidEarlyAccess("_FPDF_GetDocPermissions"));
    (Module["_FPDF_GetDocUserPermissions"] =
      makeInvalidEarlyAccess("_FPDF_GetDocUserPermissions"));
    (Module["_FPDF_GetSecurityHandlerRevision"] = makeInvalidEarlyAccess(
      "_FPDF_GetSecurityHandlerRevision",
    ));
    (Module["_FPDF_GetPageCount"] = makeInvalidEarlyAccess("_FPDF_GetPageCount"));
    (Module["_FPDF_LoadPage"] = makeInvalidEarlyAccess("_FPDF_LoadPage"));
    (Module["_FPDF_GetPageWidthF"] = makeInvalidEarlyAccess("_FPDF_GetPageWidthF"));
    (Module["_FPDF_GetPageWidth"] = makeInvalidEarlyAccess("_FPDF_GetPageWidth"));
    (Module["_FPDF_GetPageHeightF"] = makeInvalidEarlyAccess("_FPDF_GetPageHeightF"));
    (Module["_FPDF_GetPageHeight"] = makeInvalidEarlyAccess("_FPDF_GetPageHeight"));
    (Module["_FPDF_GetPageBoundingBox"] =
      makeInvalidEarlyAccess("_FPDF_GetPageBoundingBox"));
    (Module["_FPDF_RenderPageBitmap"] = makeInvalidEarlyAccess("_FPDF_RenderPageBitmap"));
    (Module["_FPDF_RenderPageBitmapWithMatrix"] = makeInvalidEarlyAccess(
      "_FPDF_RenderPageBitmapWithMatrix",
    ));
    (Module["_FPDF_ClosePage"] = makeInvalidEarlyAccess("_FPDF_ClosePage"));
    (Module["_FPDF_CloseDocument"] = makeInvalidEarlyAccess("_FPDF_CloseDocument"));
    (Module["_FPDF_GetLastError"] = makeInvalidEarlyAccess("_FPDF_GetLastError"));
    (Module["_FPDF_DeviceToPage"] = makeInvalidEarlyAccess("_FPDF_DeviceToPage"));
    (Module["_FPDF_PageToDevice"] = makeInvalidEarlyAccess("_FPDF_PageToDevice"));
    (Module["_FPDFBitmap_Create"] = makeInvalidEarlyAccess("_FPDFBitmap_Create"));
    (Module["_FPDFBitmap_CreateEx"] = makeInvalidEarlyAccess("_FPDFBitmap_CreateEx"));
    (Module["_FPDFBitmap_GetFormat"] = makeInvalidEarlyAccess("_FPDFBitmap_GetFormat"));
    (Module["_FPDFBitmap_FillRect"] = makeInvalidEarlyAccess("_FPDFBitmap_FillRect"));
    (Module["_FPDFBitmap_GetBuffer"] = makeInvalidEarlyAccess("_FPDFBitmap_GetBuffer"));
    (Module["_FPDFBitmap_GetWidth"] = makeInvalidEarlyAccess("_FPDFBitmap_GetWidth"));
    (Module["_FPDFBitmap_GetHeight"] = makeInvalidEarlyAccess("_FPDFBitmap_GetHeight"));
    (Module["_FPDFBitmap_GetStride"] = makeInvalidEarlyAccess("_FPDFBitmap_GetStride"));
    (Module["_FPDFBitmap_Destroy"] = makeInvalidEarlyAccess("_FPDFBitmap_Destroy"));
    (Module["_FPDF_GetPageSizeByIndexF"] =
      makeInvalidEarlyAccess("_FPDF_GetPageSizeByIndexF"));
    (Module["_FPDF_GetPageSizeByIndex"] =
      makeInvalidEarlyAccess("_FPDF_GetPageSizeByIndex"));
    (Module["_FPDF_VIEWERREF_GetPrintScaling"] = makeInvalidEarlyAccess(
      "_FPDF_VIEWERREF_GetPrintScaling",
    ));
    (Module["_FPDF_VIEWERREF_GetNumCopies"] =
      makeInvalidEarlyAccess("_FPDF_VIEWERREF_GetNumCopies"));
    (Module["_FPDF_VIEWERREF_GetPrintPageRange"] = makeInvalidEarlyAccess(
      "_FPDF_VIEWERREF_GetPrintPageRange",
    ));
    (Module["_FPDF_VIEWERREF_GetPrintPageRangeCount"] =
      makeInvalidEarlyAccess("_FPDF_VIEWERREF_GetPrintPageRangeCount"));
    (Module["_FPDF_VIEWERREF_GetPrintPageRangeElement"] =
      makeInvalidEarlyAccess("_FPDF_VIEWERREF_GetPrintPageRangeElement"));
    (Module["_FPDF_VIEWERREF_GetDuplex"] =
      makeInvalidEarlyAccess("_FPDF_VIEWERREF_GetDuplex"));
    (Module["_FPDF_VIEWERREF_GetName"] =
      makeInvalidEarlyAccess("_FPDF_VIEWERREF_GetName"));
    (Module["_FPDF_CountNamedDests"] = makeInvalidEarlyAccess("_FPDF_CountNamedDests"));
    (Module["_FPDF_GetNamedDestByName"] =
      makeInvalidEarlyAccess("_FPDF_GetNamedDestByName"));
    (Module["_FPDF_GetNamedDest"] = makeInvalidEarlyAccess("_FPDF_GetNamedDest"));
    (Module["_FPDF_GetXFAPacketCount"] =
      makeInvalidEarlyAccess("_FPDF_GetXFAPacketCount"));
    (Module["_FPDF_GetXFAPacketName"] = makeInvalidEarlyAccess("_FPDF_GetXFAPacketName"));
    (Module["_FPDF_GetXFAPacketContent"] =
      makeInvalidEarlyAccess("_FPDF_GetXFAPacketContent"));
    (Module["_FPDF_GetTrailerEnds"] = makeInvalidEarlyAccess("_FPDF_GetTrailerEnds"));
    var _fflush = makeInvalidEarlyAccess("_fflush");
    var _emscripten_stack_get_end = makeInvalidEarlyAccess("_emscripten_stack_get_end");
    var _emscripten_builtin_memalign = makeInvalidEarlyAccess("_emscripten_builtin_memalign");
    var _strerror = makeInvalidEarlyAccess("_strerror");
    var _setThrew = makeInvalidEarlyAccess("_setThrew");
    var _emscripten_stack_init = makeInvalidEarlyAccess("_emscripten_stack_init");
    var __emscripten_stack_restore = makeInvalidEarlyAccess("__emscripten_stack_restore");
    var __emscripten_stack_alloc = makeInvalidEarlyAccess("__emscripten_stack_alloc");
    var _emscripten_stack_get_current = makeInvalidEarlyAccess("_emscripten_stack_get_current");
    function assignWasmExports(wasmExports) {
      Module["_PDFium_Init"] = createExportWrapper("PDFium_Init", 0);
      Module["_FPDF_InitLibraryWithConfig"] = createExportWrapper(
        "FPDF_InitLibraryWithConfig",
        1,
      );
      Module["_FPDFAnnot_IsSupportedSubtype"] = createExportWrapper(
        "FPDFAnnot_IsSupportedSubtype",
        1,
      );
      Module["_FPDFPage_CreateAnnot"] = createExportWrapper("FPDFPage_CreateAnnot", 2);
      Module["_FPDFPage_GetAnnotCount"] = createExportWrapper("FPDFPage_GetAnnotCount", 1);
      Module["_FPDFPage_GetAnnot"] = createExportWrapper("FPDFPage_GetAnnot", 2);
      Module["_FPDFPage_GetAnnotIndex"] = createExportWrapper("FPDFPage_GetAnnotIndex", 2);
      Module["_FPDFPage_CloseAnnot"] = createExportWrapper("FPDFPage_CloseAnnot", 1);
      Module["_FPDFPage_RemoveAnnot"] = createExportWrapper("FPDFPage_RemoveAnnot", 2);
      Module["_FPDFAnnot_GetSubtype"] = createExportWrapper("FPDFAnnot_GetSubtype", 1);
      Module["_FPDFAnnot_IsObjectSupportedSubtype"] = createExportWrapper(
        "FPDFAnnot_IsObjectSupportedSubtype",
        1,
      );
      Module["_FPDFAnnot_UpdateObject"] = createExportWrapper("FPDFAnnot_UpdateObject", 2);
      Module["_FPDFAnnot_AddInkStroke"] = createExportWrapper("FPDFAnnot_AddInkStroke", 3);
      Module["_FPDFAnnot_RemoveInkList"] = createExportWrapper("FPDFAnnot_RemoveInkList", 1);
      Module["_FPDFAnnot_AppendObject"] = createExportWrapper("FPDFAnnot_AppendObject", 2);
      Module["_FPDFAnnot_GetObjectCount"] = createExportWrapper(
        "FPDFAnnot_GetObjectCount",
        1,
      );
      Module["_FPDFAnnot_GetObject"] = createExportWrapper("FPDFAnnot_GetObject", 2);
      Module["_FPDFAnnot_RemoveObject"] = createExportWrapper("FPDFAnnot_RemoveObject", 2);
      Module["_FPDFAnnot_SetColor"] = createExportWrapper("FPDFAnnot_SetColor", 6);
      Module["_FPDFAnnot_GetColor"] = createExportWrapper("FPDFAnnot_GetColor", 6);
      Module["_FPDFAnnot_HasAttachmentPoints"] = createExportWrapper(
        "FPDFAnnot_HasAttachmentPoints",
        1,
      );
      Module["_FPDFAnnot_SetAttachmentPoints"] = createExportWrapper(
        "FPDFAnnot_SetAttachmentPoints",
        3,
      );
      Module["_FPDFAnnot_AppendAttachmentPoints"] = createExportWrapper(
        "FPDFAnnot_AppendAttachmentPoints",
        2,
      );
      Module["_FPDFAnnot_CountAttachmentPoints"] = createExportWrapper(
        "FPDFAnnot_CountAttachmentPoints",
        1,
      );
      Module["_FPDFAnnot_GetAttachmentPoints"] = createExportWrapper(
        "FPDFAnnot_GetAttachmentPoints",
        3,
      );
      Module["_FPDFAnnot_SetRect"] = createExportWrapper("FPDFAnnot_SetRect", 2);
      Module["_FPDFAnnot_GetRect"] = createExportWrapper("FPDFAnnot_GetRect", 2);
      Module["_FPDFAnnot_GetVertices"] = createExportWrapper("FPDFAnnot_GetVertices", 3);
      Module["_FPDFAnnot_GetInkListCount"] = createExportWrapper(
        "FPDFAnnot_GetInkListCount",
        1,
      );
      Module["_FPDFAnnot_GetInkListPath"] = createExportWrapper(
        "FPDFAnnot_GetInkListPath",
        4,
      );
      Module["_FPDFAnnot_GetLine"] = createExportWrapper("FPDFAnnot_GetLine", 3);
      Module["_FPDFAnnot_SetBorder"] = createExportWrapper("FPDFAnnot_SetBorder", 4);
      Module["_FPDFAnnot_GetBorder"] = createExportWrapper("FPDFAnnot_GetBorder", 4);
      Module["_FPDFAnnot_HasKey"] = createExportWrapper("FPDFAnnot_HasKey", 2);
      Module["_FPDFAnnot_GetValueType"] = createExportWrapper("FPDFAnnot_GetValueType", 2);
      Module["_FPDFAnnot_SetStringValue"] = createExportWrapper(
        "FPDFAnnot_SetStringValue",
        3,
      );
      Module["_FPDFAnnot_GetStringValue"] = createExportWrapper(
        "FPDFAnnot_GetStringValue",
        4,
      );
      Module["_FPDFAnnot_GetNumberValue"] = createExportWrapper(
        "FPDFAnnot_GetNumberValue",
        3,
      );
      Module["_FPDFAnnot_SetAP"] = createExportWrapper("FPDFAnnot_SetAP", 3);
      Module["_FPDFAnnot_GetAP"] = createExportWrapper("FPDFAnnot_GetAP", 4);
      Module["_FPDFAnnot_GetLinkedAnnot"] = createExportWrapper(
        "FPDFAnnot_GetLinkedAnnot",
        2,
      );
      Module["_FPDFAnnot_GetFlags"] = createExportWrapper("FPDFAnnot_GetFlags", 1);
      Module["_FPDFAnnot_SetFlags"] = createExportWrapper("FPDFAnnot_SetFlags", 2);
      Module["_FPDFAnnot_GetFormFieldFlags"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldFlags",
        2,
      );
      Module["_FPDFAnnot_SetFormFieldFlags"] = createExportWrapper(
        "FPDFAnnot_SetFormFieldFlags",
        3,
      );
      Module["_FPDFAnnot_GetFormFieldAtPoint"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldAtPoint",
        3,
      );
      Module["_FPDFAnnot_GetFormFieldName"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldName",
        4,
      );
      Module["_FPDFAnnot_GetFormFieldType"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldType",
        2,
      );
      Module["_FPDFAnnot_GetFormAdditionalActionJavaScript"] = createExportWrapper("FPDFAnnot_GetFormAdditionalActionJavaScript", 5);
      Module["_FPDFAnnot_GetFormFieldAlternateName"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldAlternateName",
        4,
      );
      Module["_FPDFAnnot_GetFormFieldValue"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldValue",
        4,
      );
      Module["_FPDFAnnot_GetOptionCount"] = createExportWrapper(
        "FPDFAnnot_GetOptionCount",
        2,
      );
      Module["_FPDFAnnot_GetOptionLabel"] = createExportWrapper(
        "FPDFAnnot_GetOptionLabel",
        5,
      );
      Module["_FPDFAnnot_IsOptionSelected"] = createExportWrapper(
        "FPDFAnnot_IsOptionSelected",
        3,
      );
      Module["_FPDFAnnot_GetFontSize"] = createExportWrapper("FPDFAnnot_GetFontSize", 3);
      Module["_FPDFAnnot_SetFontColor"] = createExportWrapper("FPDFAnnot_SetFontColor", 5);
      Module["_FPDFAnnot_GetFontColor"] = createExportWrapper("FPDFAnnot_GetFontColor", 5);
      Module["_FPDFAnnot_IsChecked"] = createExportWrapper("FPDFAnnot_IsChecked", 2);
      Module["_FPDFAnnot_SetFocusableSubtypes"] = createExportWrapper(
        "FPDFAnnot_SetFocusableSubtypes",
        3,
      );
      Module["_FPDFAnnot_GetFocusableSubtypesCount"] = createExportWrapper(
        "FPDFAnnot_GetFocusableSubtypesCount",
        1,
      );
      Module["_FPDFAnnot_GetFocusableSubtypes"] = createExportWrapper(
        "FPDFAnnot_GetFocusableSubtypes",
        3,
      );
      Module["_FPDFAnnot_GetLink"] = createExportWrapper("FPDFAnnot_GetLink", 1);
      Module["_FPDFAnnot_GetFormControlCount"] = createExportWrapper(
        "FPDFAnnot_GetFormControlCount",
        2,
      );
      Module["_FPDFAnnot_GetFormControlIndex"] = createExportWrapper(
        "FPDFAnnot_GetFormControlIndex",
        2,
      );
      Module["_FPDFAnnot_GetFormFieldExportValue"] = createExportWrapper(
        "FPDFAnnot_GetFormFieldExportValue",
        4,
      );
      Module["_FPDFAnnot_SetURI"] = createExportWrapper("FPDFAnnot_SetURI", 2);
      Module["_FPDFAnnot_GetFileAttachment"] = createExportWrapper(
        "FPDFAnnot_GetFileAttachment",
        1,
      );
      Module["_FPDFAnnot_AddFileAttachment"] = createExportWrapper(
        "FPDFAnnot_AddFileAttachment",
        2,
      );
      Module["_FPDFDoc_GetAttachmentCount"] = createExportWrapper(
        "FPDFDoc_GetAttachmentCount",
        1,
      );
      Module["_FPDFDoc_AddAttachment"] = createExportWrapper("FPDFDoc_AddAttachment", 2);
      Module["_FPDFDoc_GetAttachment"] = createExportWrapper("FPDFDoc_GetAttachment", 2);
      Module["_FPDFDoc_DeleteAttachment"] = createExportWrapper(
        "FPDFDoc_DeleteAttachment",
        2,
      );
      Module["_FPDFAttachment_GetName"] = createExportWrapper("FPDFAttachment_GetName", 3);
      Module["_FPDFAttachment_HasKey"] = createExportWrapper("FPDFAttachment_HasKey", 2);
      Module["_FPDFAttachment_GetValueType"] = createExportWrapper(
        "FPDFAttachment_GetValueType",
        2,
      );
      Module["_FPDFAttachment_SetStringValue"] = createExportWrapper(
        "FPDFAttachment_SetStringValue",
        3,
      );
      Module["_FPDFAttachment_GetStringValue"] = createExportWrapper(
        "FPDFAttachment_GetStringValue",
        4,
      );
      Module["_FPDFAttachment_SetFile"] = createExportWrapper("FPDFAttachment_SetFile", 4);
      Module["_FPDFAttachment_GetFile"] = createExportWrapper("FPDFAttachment_GetFile", 4);
      Module["_FPDFAttachment_GetSubtype"] = createExportWrapper(
        "FPDFAttachment_GetSubtype",
        3,
      );
      Module["_FPDFCatalog_IsTagged"] = createExportWrapper("FPDFCatalog_IsTagged", 1);
      Module["_FPDFCatalog_SetLanguage"] = createExportWrapper("FPDFCatalog_SetLanguage", 2);
      Module["_FPDFAvail_Create"] = createExportWrapper("FPDFAvail_Create", 2);
      Module["_FPDFAvail_Destroy"] = createExportWrapper("FPDFAvail_Destroy", 1);
      Module["_FPDFAvail_IsDocAvail"] = createExportWrapper("FPDFAvail_IsDocAvail", 2);
      Module["_FPDFAvail_GetDocument"] = createExportWrapper("FPDFAvail_GetDocument", 2);
      Module["_FPDFAvail_GetFirstPageNum"] = createExportWrapper(
        "FPDFAvail_GetFirstPageNum",
        1,
      );
      Module["_FPDFAvail_IsPageAvail"] = createExportWrapper("FPDFAvail_IsPageAvail", 3);
      Module["_FPDFAvail_IsFormAvail"] = createExportWrapper("FPDFAvail_IsFormAvail", 2);
      Module["_FPDFAvail_IsLinearized"] = createExportWrapper("FPDFAvail_IsLinearized", 1);
      Module["_FPDFBookmark_GetFirstChild"] = createExportWrapper(
        "FPDFBookmark_GetFirstChild",
        2,
      );
      Module["_FPDFBookmark_GetNextSibling"] = createExportWrapper(
        "FPDFBookmark_GetNextSibling",
        2,
      );
      Module["_FPDFBookmark_GetTitle"] = createExportWrapper("FPDFBookmark_GetTitle", 3);
      Module["_FPDFBookmark_GetCount"] = createExportWrapper("FPDFBookmark_GetCount", 1);
      Module["_FPDFBookmark_Find"] = createExportWrapper("FPDFBookmark_Find", 2);
      Module["_FPDFBookmark_GetDest"] = createExportWrapper("FPDFBookmark_GetDest", 2);
      Module["_FPDFBookmark_GetAction"] = createExportWrapper("FPDFBookmark_GetAction", 1);
      Module["_FPDFAction_GetType"] = createExportWrapper("FPDFAction_GetType", 1);
      Module["_FPDFAction_GetDest"] = createExportWrapper("FPDFAction_GetDest", 2);
      Module["_FPDFAction_GetFilePath"] = createExportWrapper("FPDFAction_GetFilePath", 3);
      Module["_FPDFAction_GetURIPath"] = createExportWrapper("FPDFAction_GetURIPath", 4);
      Module["_FPDFDest_GetDestPageIndex"] = createExportWrapper(
        "FPDFDest_GetDestPageIndex",
        2,
      );
      Module["_FPDFDest_GetView"] = createExportWrapper("FPDFDest_GetView", 3);
      Module["_FPDFDest_GetLocationInPage"] = createExportWrapper(
        "FPDFDest_GetLocationInPage",
        7,
      );
      Module["_FPDFLink_GetLinkAtPoint"] = createExportWrapper("FPDFLink_GetLinkAtPoint", 3);
      Module["_FPDFLink_GetLinkZOrderAtPoint"] = createExportWrapper(
        "FPDFLink_GetLinkZOrderAtPoint",
        3,
      );
      Module["_FPDFLink_GetDest"] = createExportWrapper("FPDFLink_GetDest", 2);
      Module["_FPDFLink_GetAction"] = createExportWrapper("FPDFLink_GetAction", 1);
      Module["_FPDFLink_Enumerate"] = createExportWrapper("FPDFLink_Enumerate", 3);
      Module["_FPDFLink_GetAnnot"] = createExportWrapper("FPDFLink_GetAnnot", 2);
      Module["_FPDFLink_GetAnnotRect"] = createExportWrapper("FPDFLink_GetAnnotRect", 2);
      Module["_FPDFLink_CountQuadPoints"] = createExportWrapper(
        "FPDFLink_CountQuadPoints",
        1,
      );
      Module["_FPDFLink_GetQuadPoints"] = createExportWrapper("FPDFLink_GetQuadPoints", 3);
      Module["_FPDF_GetPageAAction"] = createExportWrapper("FPDF_GetPageAAction", 2);
      Module["_FPDF_GetFileIdentifier"] = createExportWrapper("FPDF_GetFileIdentifier", 4);
      Module["_FPDF_GetMetaText"] = createExportWrapper("FPDF_GetMetaText", 4);
      Module["_FPDF_GetPageLabel"] = createExportWrapper("FPDF_GetPageLabel", 4);
      Module["_FPDFPageObj_NewImageObj"] = createExportWrapper("FPDFPageObj_NewImageObj", 1);
      Module["_FPDFImageObj_LoadJpegFile"] = createExportWrapper(
        "FPDFImageObj_LoadJpegFile",
        4,
      );
      Module["_FPDFImageObj_LoadJpegFileInline"] = createExportWrapper(
        "FPDFImageObj_LoadJpegFileInline",
        4,
      );
      Module["_FPDFImageObj_SetMatrix"] = createExportWrapper("FPDFImageObj_SetMatrix", 7);
      Module["_FPDFImageObj_SetBitmap"] = createExportWrapper("FPDFImageObj_SetBitmap", 4);
      Module["_FPDFImageObj_GetBitmap"] = createExportWrapper("FPDFImageObj_GetBitmap", 1);
      Module["_FPDFImageObj_GetRenderedBitmap"] = createExportWrapper(
        "FPDFImageObj_GetRenderedBitmap",
        3,
      );
      Module["_FPDFImageObj_GetImageDataDecoded"] = createExportWrapper(
        "FPDFImageObj_GetImageDataDecoded",
        3,
      );
      Module["_FPDFImageObj_GetImageDataRaw"] = createExportWrapper(
        "FPDFImageObj_GetImageDataRaw",
        3,
      );
      Module["_FPDFImageObj_GetImageFilterCount"] = createExportWrapper(
        "FPDFImageObj_GetImageFilterCount",
        1,
      );
      Module["_FPDFImageObj_GetImageFilter"] = createExportWrapper(
        "FPDFImageObj_GetImageFilter",
        4,
      );
      Module["_FPDFImageObj_GetImageMetadata"] = createExportWrapper(
        "FPDFImageObj_GetImageMetadata",
        3,
      );
      Module["_FPDFImageObj_GetImagePixelSize"] = createExportWrapper(
        "FPDFImageObj_GetImagePixelSize",
        3,
      );
      Module["_FPDFImageObj_GetIccProfileDataDecoded"] = createExportWrapper(
        "FPDFImageObj_GetIccProfileDataDecoded",
        5,
      );
      Module["_FPDF_CreateNewDocument"] = createExportWrapper("FPDF_CreateNewDocument", 0);
      Module["_FPDFPage_Delete"] = createExportWrapper("FPDFPage_Delete", 2);
      Module["_FPDF_MovePages"] = createExportWrapper("FPDF_MovePages", 4);
      Module["_FPDFPage_New"] = createExportWrapper("FPDFPage_New", 4);
      Module["_FPDFPage_GetRotation"] = createExportWrapper("FPDFPage_GetRotation", 1);
      Module["_FPDFPage_InsertObject"] = createExportWrapper("FPDFPage_InsertObject", 2);
      Module["_FPDFPage_InsertObjectAtIndex"] = createExportWrapper(
        "FPDFPage_InsertObjectAtIndex",
        3,
      );
      Module["_FPDFPage_RemoveObject"] = createExportWrapper("FPDFPage_RemoveObject", 2);
      Module["_FPDFPage_CountObjects"] = createExportWrapper("FPDFPage_CountObjects", 1);
      Module["_FPDFPage_GetObject"] = createExportWrapper("FPDFPage_GetObject", 2);
      Module["_FPDFPage_HasTransparency"] = createExportWrapper(
        "FPDFPage_HasTransparency",
        1,
      );
      Module["_FPDFPageObj_Destroy"] = createExportWrapper("FPDFPageObj_Destroy", 1);
      Module["_FPDFPageObj_GetMarkedContentID"] = createExportWrapper(
        "FPDFPageObj_GetMarkedContentID",
        1,
      );
      Module["_FPDFPageObj_CountMarks"] = createExportWrapper("FPDFPageObj_CountMarks", 1);
      Module["_FPDFPageObj_GetMark"] = createExportWrapper("FPDFPageObj_GetMark", 2);
      Module["_FPDFPageObj_AddMark"] = createExportWrapper("FPDFPageObj_AddMark", 2);
      Module["_FPDFPageObj_RemoveMark"] = createExportWrapper("FPDFPageObj_RemoveMark", 2);
      Module["_FPDFPageObjMark_GetName"] = createExportWrapper("FPDFPageObjMark_GetName", 4);
      Module["_FPDFPageObjMark_CountParams"] = createExportWrapper(
        "FPDFPageObjMark_CountParams",
        1,
      );
      Module["_FPDFPageObjMark_GetParamKey"] = createExportWrapper(
        "FPDFPageObjMark_GetParamKey",
        5,
      );
      Module["_FPDFPageObjMark_GetParamValueType"] = createExportWrapper(
        "FPDFPageObjMark_GetParamValueType",
        2,
      );
      Module["_FPDFPageObjMark_GetParamIntValue"] = createExportWrapper(
        "FPDFPageObjMark_GetParamIntValue",
        3,
      );
      Module["_FPDFPageObjMark_GetParamStringValue"] = createExportWrapper(
        "FPDFPageObjMark_GetParamStringValue",
        5,
      );
      Module["_FPDFPageObjMark_GetParamBlobValue"] = createExportWrapper(
        "FPDFPageObjMark_GetParamBlobValue",
        5,
      );
      Module["_FPDFPageObj_HasTransparency"] = createExportWrapper(
        "FPDFPageObj_HasTransparency",
        1,
      );
      Module["_FPDFPageObjMark_SetIntParam"] = createExportWrapper(
        "FPDFPageObjMark_SetIntParam",
        5,
      );
      Module["_FPDFPageObjMark_SetStringParam"] = createExportWrapper(
        "FPDFPageObjMark_SetStringParam",
        5,
      );
      Module["_FPDFPageObjMark_SetBlobParam"] = createExportWrapper(
        "FPDFPageObjMark_SetBlobParam",
        6,
      );
      Module["_FPDFPageObjMark_RemoveParam"] = createExportWrapper(
        "FPDFPageObjMark_RemoveParam",
        3,
      );
      Module["_FPDFPageObj_GetType"] = createExportWrapper("FPDFPageObj_GetType", 1);
      Module["_FPDFPageObj_GetIsActive"] = createExportWrapper("FPDFPageObj_GetIsActive", 2);
      Module["_FPDFPageObj_SetIsActive"] = createExportWrapper("FPDFPageObj_SetIsActive", 2);
      Module["_FPDFPage_GenerateContent"] = createExportWrapper(
        "FPDFPage_GenerateContent",
        1,
      );
      Module["_FPDFPageObj_Transform"] = createExportWrapper("FPDFPageObj_Transform", 7);
      Module["_FPDFPageObj_TransformF"] = createExportWrapper("FPDFPageObj_TransformF", 2);
      Module["_FPDFPageObj_GetMatrix"] = createExportWrapper("FPDFPageObj_GetMatrix", 2);
      Module["_FPDFPageObj_SetMatrix"] = createExportWrapper("FPDFPageObj_SetMatrix", 2);
      Module["_FPDFPageObj_SetBlendMode"] = createExportWrapper(
        "FPDFPageObj_SetBlendMode",
        2,
      );
      Module["_FPDFPage_TransformAnnots"] = createExportWrapper(
        "FPDFPage_TransformAnnots",
        7,
      );
      Module["_FPDFPage_SetRotation"] = createExportWrapper("FPDFPage_SetRotation", 2);
      Module["_FPDFPageObj_SetFillColor"] = createExportWrapper(
        "FPDFPageObj_SetFillColor",
        5,
      );
      Module["_FPDFPageObj_GetFillColor"] = createExportWrapper(
        "FPDFPageObj_GetFillColor",
        5,
      );
      Module["_FPDFPageObj_GetBounds"] = createExportWrapper("FPDFPageObj_GetBounds", 5);
      Module["_FPDFPageObj_GetRotatedBounds"] = createExportWrapper(
        "FPDFPageObj_GetRotatedBounds",
        2,
      );
      Module["_FPDFPageObj_SetStrokeColor"] = createExportWrapper(
        "FPDFPageObj_SetStrokeColor",
        5,
      );
      Module["_FPDFPageObj_GetStrokeColor"] = createExportWrapper(
        "FPDFPageObj_GetStrokeColor",
        5,
      );
      Module["_FPDFPageObj_SetStrokeWidth"] = createExportWrapper(
        "FPDFPageObj_SetStrokeWidth",
        2,
      );
      Module["_FPDFPageObj_GetStrokeWidth"] = createExportWrapper(
        "FPDFPageObj_GetStrokeWidth",
        2,
      );
      Module["_FPDFPageObj_GetLineJoin"] = createExportWrapper("FPDFPageObj_GetLineJoin", 1);
      Module["_FPDFPageObj_SetLineJoin"] = createExportWrapper("FPDFPageObj_SetLineJoin", 2);
      Module["_FPDFPageObj_GetLineCap"] = createExportWrapper("FPDFPageObj_GetLineCap", 1);
      Module["_FPDFPageObj_SetLineCap"] = createExportWrapper("FPDFPageObj_SetLineCap", 2);
      Module["_FPDFPageObj_GetDashPhase"] = createExportWrapper(
        "FPDFPageObj_GetDashPhase",
        2,
      );
      Module["_FPDFPageObj_SetDashPhase"] = createExportWrapper(
        "FPDFPageObj_SetDashPhase",
        2,
      );
      Module["_FPDFPageObj_GetDashCount"] = createExportWrapper(
        "FPDFPageObj_GetDashCount",
        1,
      );
      Module["_FPDFPageObj_GetDashArray"] = createExportWrapper(
        "FPDFPageObj_GetDashArray",
        3,
      );
      Module["_FPDFPageObj_SetDashArray"] = createExportWrapper(
        "FPDFPageObj_SetDashArray",
        4,
      );
      Module["_FPDFFormObj_CountObjects"] = createExportWrapper(
        "FPDFFormObj_CountObjects",
        1,
      );
      Module["_FPDFFormObj_GetObject"] = createExportWrapper("FPDFFormObj_GetObject", 2);
      Module["_FPDFFormObj_RemoveObject"] = createExportWrapper(
        "FPDFFormObj_RemoveObject",
        2,
      );
      Module["_FPDFPageObj_CreateNewPath"] = createExportWrapper(
        "FPDFPageObj_CreateNewPath",
        2,
      );
      Module["_FPDFPageObj_CreateNewRect"] = createExportWrapper(
        "FPDFPageObj_CreateNewRect",
        4,
      );
      Module["_FPDFPath_CountSegments"] = createExportWrapper("FPDFPath_CountSegments", 1);
      Module["_FPDFPath_GetPathSegment"] = createExportWrapper("FPDFPath_GetPathSegment", 2);
      Module["_FPDFPath_MoveTo"] = createExportWrapper("FPDFPath_MoveTo", 3);
      Module["_FPDFPath_LineTo"] = createExportWrapper("FPDFPath_LineTo", 3);
      Module["_FPDFPath_BezierTo"] = createExportWrapper("FPDFPath_BezierTo", 7);
      Module["_FPDFPath_Close"] = createExportWrapper("FPDFPath_Close", 1);
      Module["_FPDFPath_SetDrawMode"] = createExportWrapper("FPDFPath_SetDrawMode", 3);
      Module["_FPDFPath_GetDrawMode"] = createExportWrapper("FPDFPath_GetDrawMode", 3);
      Module["_FPDFPathSegment_GetPoint"] = createExportWrapper(
        "FPDFPathSegment_GetPoint",
        3,
      );
      Module["_FPDFPathSegment_GetType"] = createExportWrapper("FPDFPathSegment_GetType", 1);
      Module["_FPDFPathSegment_GetClose"] = createExportWrapper(
        "FPDFPathSegment_GetClose",
        1,
      );
      Module["_FPDFPageObj_NewTextObj"] = createExportWrapper("FPDFPageObj_NewTextObj", 3);
      Module["_FPDFText_SetText"] = createExportWrapper("FPDFText_SetText", 2);
      Module["_FPDFText_SetCharcodes"] = createExportWrapper("FPDFText_SetCharcodes", 3);
      Module["_FPDFText_LoadFont"] = createExportWrapper("FPDFText_LoadFont", 5);
      Module["_FPDFText_LoadStandardFont"] = createExportWrapper(
        "FPDFText_LoadStandardFont",
        2,
      );
      Module["_FPDFText_LoadCidType2Font"] = createExportWrapper(
        "FPDFText_LoadCidType2Font",
        6,
      );
      Module["_FPDFTextObj_GetFontSize"] = createExportWrapper("FPDFTextObj_GetFontSize", 2);
      Module["_FPDFTextObj_GetText"] = createExportWrapper("FPDFTextObj_GetText", 4);
      Module["_FPDFTextObj_GetRenderedBitmap"] = createExportWrapper(
        "FPDFTextObj_GetRenderedBitmap",
        4,
      );
      Module["_FPDFFont_Close"] = createExportWrapper("FPDFFont_Close", 1);
      Module["_FPDFPageObj_CreateTextObj"] = createExportWrapper(
        "FPDFPageObj_CreateTextObj",
        3,
      );
      Module["_FPDFTextObj_GetTextRenderMode"] = createExportWrapper(
        "FPDFTextObj_GetTextRenderMode",
        1,
      );
      Module["_FPDFTextObj_SetTextRenderMode"] = createExportWrapper(
        "FPDFTextObj_SetTextRenderMode",
        2,
      );
      Module["_FPDFTextObj_GetFont"] = createExportWrapper("FPDFTextObj_GetFont", 1);
      Module["_FPDFFont_GetBaseFontName"] = createExportWrapper(
        "FPDFFont_GetBaseFontName",
        3,
      );
      Module["_FPDFFont_GetFamilyName"] = createExportWrapper("FPDFFont_GetFamilyName", 3);
      Module["_FPDFFont_GetFontData"] = createExportWrapper("FPDFFont_GetFontData", 4);
      Module["_FPDFFont_GetIsEmbedded"] = createExportWrapper("FPDFFont_GetIsEmbedded", 1);
      Module["_FPDFFont_GetFlags"] = createExportWrapper("FPDFFont_GetFlags", 1);
      Module["_FPDFFont_GetWeight"] = createExportWrapper("FPDFFont_GetWeight", 1);
      Module["_FPDFFont_GetItalicAngle"] = createExportWrapper("FPDFFont_GetItalicAngle", 2);
      Module["_FPDFFont_GetAscent"] = createExportWrapper("FPDFFont_GetAscent", 3);
      Module["_FPDFFont_GetDescent"] = createExportWrapper("FPDFFont_GetDescent", 3);
      Module["_FPDFFont_GetGlyphWidth"] = createExportWrapper("FPDFFont_GetGlyphWidth", 4);
      Module["_FPDFFont_GetGlyphPath"] = createExportWrapper("FPDFFont_GetGlyphPath", 3);
      Module["_FPDFGlyphPath_CountGlyphSegments"] = createExportWrapper(
        "FPDFGlyphPath_CountGlyphSegments",
        1,
      );
      Module["_FPDFGlyphPath_GetGlyphPathSegment"] = createExportWrapper(
        "FPDFGlyphPath_GetGlyphPathSegment",
        2,
      );
      Module["_FSDK_SetUnSpObjProcessHandler"] = createExportWrapper(
        "FSDK_SetUnSpObjProcessHandler",
        1,
      );
      Module["_FSDK_SetTimeFunction"] = createExportWrapper("FSDK_SetTimeFunction", 1);
      Module["_FSDK_SetLocaltimeFunction"] = createExportWrapper(
        "FSDK_SetLocaltimeFunction",
        1,
      );
      Module["_FPDFDoc_GetPageMode"] = createExportWrapper("FPDFDoc_GetPageMode", 1);
      Module["_FPDFPage_Flatten"] = createExportWrapper("FPDFPage_Flatten", 2);
      Module["_FPDFPage_HasFormFieldAtPoint"] = createExportWrapper(
        "FPDFPage_HasFormFieldAtPoint",
        4,
      );
      Module["_FPDFPage_FormFieldZOrderAtPoint"] = createExportWrapper(
        "FPDFPage_FormFieldZOrderAtPoint",
        4,
      );
      Module["_FPDFDOC_InitFormFillEnvironment"] = createExportWrapper(
        "FPDFDOC_InitFormFillEnvironment",
        2,
      );
      Module["_FPDFDOC_ExitFormFillEnvironment"] = createExportWrapper(
        "FPDFDOC_ExitFormFillEnvironment",
        1,
      );
      Module["_FORM_OnMouseMove"] = createExportWrapper("FORM_OnMouseMove", 5);
      Module["_FORM_OnMouseWheel"] = createExportWrapper("FORM_OnMouseWheel", 6);
      Module["_FORM_OnFocus"] = createExportWrapper("FORM_OnFocus", 5);
      Module["_FORM_OnLButtonDown"] = createExportWrapper("FORM_OnLButtonDown", 5);
      Module["_FORM_OnLButtonUp"] = createExportWrapper("FORM_OnLButtonUp", 5);
      Module["_FORM_OnLButtonDoubleClick"] = createExportWrapper(
        "FORM_OnLButtonDoubleClick",
        5,
      );
      Module["_FORM_OnRButtonDown"] = createExportWrapper("FORM_OnRButtonDown", 5);
      Module["_FORM_OnRButtonUp"] = createExportWrapper("FORM_OnRButtonUp", 5);
      Module["_FORM_OnKeyDown"] = createExportWrapper("FORM_OnKeyDown", 4);
      Module["_FORM_OnKeyUp"] = createExportWrapper("FORM_OnKeyUp", 4);
      Module["_FORM_OnChar"] = createExportWrapper("FORM_OnChar", 4);
      Module["_FORM_GetFocusedText"] = createExportWrapper("FORM_GetFocusedText", 4);
      Module["_FORM_GetSelectedText"] = createExportWrapper("FORM_GetSelectedText", 4);
      Module["_FORM_ReplaceAndKeepSelection"] = createExportWrapper(
        "FORM_ReplaceAndKeepSelection",
        3,
      );
      Module["_FORM_ReplaceSelection"] = createExportWrapper("FORM_ReplaceSelection", 3);
      Module["_FORM_SelectAllText"] = createExportWrapper("FORM_SelectAllText", 2);
      Module["_FORM_CanUndo"] = createExportWrapper("FORM_CanUndo", 2);
      Module["_FORM_CanRedo"] = createExportWrapper("FORM_CanRedo", 2);
      Module["_FORM_Undo"] = createExportWrapper("FORM_Undo", 2);
      Module["_FORM_Redo"] = createExportWrapper("FORM_Redo", 2);
      Module["_FORM_ForceToKillFocus"] = createExportWrapper("FORM_ForceToKillFocus", 1);
      Module["_FORM_GetFocusedAnnot"] = createExportWrapper("FORM_GetFocusedAnnot", 3);
      Module["_FORM_SetFocusedAnnot"] = createExportWrapper("FORM_SetFocusedAnnot", 2);
      Module["_FPDF_FFLDraw"] = createExportWrapper("FPDF_FFLDraw", 9);
      Module["_FPDF_SetFormFieldHighlightColor"] = createExportWrapper(
        "FPDF_SetFormFieldHighlightColor",
        3,
      );
      Module["_FPDF_SetFormFieldHighlightAlpha"] = createExportWrapper(
        "FPDF_SetFormFieldHighlightAlpha",
        2,
      );
      Module["_FPDF_RemoveFormFieldHighlight"] = createExportWrapper(
        "FPDF_RemoveFormFieldHighlight",
        1,
      );
      Module["_FORM_OnAfterLoadPage"] = createExportWrapper("FORM_OnAfterLoadPage", 2);
      Module["_FORM_OnBeforeClosePage"] = createExportWrapper("FORM_OnBeforeClosePage", 2);
      Module["_FORM_DoDocumentJSAction"] = createExportWrapper("FORM_DoDocumentJSAction", 1);
      Module["_FORM_DoDocumentOpenAction"] = createExportWrapper(
        "FORM_DoDocumentOpenAction",
        1,
      );
      Module["_FORM_DoDocumentAAction"] = createExportWrapper("FORM_DoDocumentAAction", 2);
      Module["_FORM_DoPageAAction"] = createExportWrapper("FORM_DoPageAAction", 3);
      Module["_FORM_SetIndexSelected"] = createExportWrapper("FORM_SetIndexSelected", 4);
      Module["_FORM_IsIndexSelected"] = createExportWrapper("FORM_IsIndexSelected", 3);
      Module["_FPDFDoc_GetJavaScriptActionCount"] = createExportWrapper(
        "FPDFDoc_GetJavaScriptActionCount",
        1,
      );
      Module["_FPDFDoc_GetJavaScriptAction"] = createExportWrapper(
        "FPDFDoc_GetJavaScriptAction",
        2,
      );
      Module["_FPDFDoc_CloseJavaScriptAction"] = createExportWrapper(
        "FPDFDoc_CloseJavaScriptAction",
        1,
      );
      Module["_FPDFJavaScriptAction_GetName"] = createExportWrapper(
        "FPDFJavaScriptAction_GetName",
        3,
      );
      Module["_FPDFJavaScriptAction_GetScript"] = createExportWrapper(
        "FPDFJavaScriptAction_GetScript",
        3,
      );
      Module["_FPDF_ImportPagesByIndex"] = createExportWrapper("FPDF_ImportPagesByIndex", 5);
      Module["_FPDF_ImportPages"] = createExportWrapper("FPDF_ImportPages", 4);
      Module["_FPDF_ImportNPagesToOne"] = createExportWrapper("FPDF_ImportNPagesToOne", 5);
      Module["_FPDF_NewXObjectFromPage"] = createExportWrapper("FPDF_NewXObjectFromPage", 3);
      Module["_FPDF_CloseXObject"] = createExportWrapper("FPDF_CloseXObject", 1);
      Module["_FPDF_NewFormObjectFromXObject"] = createExportWrapper(
        "FPDF_NewFormObjectFromXObject",
        1,
      );
      Module["_FPDF_CopyViewerPreferences"] = createExportWrapper(
        "FPDF_CopyViewerPreferences",
        2,
      );
      Module["_FPDF_RenderPageBitmapWithColorScheme_Start"] = createExportWrapper("FPDF_RenderPageBitmapWithColorScheme_Start", 10);
      Module["_FPDF_RenderPageBitmap_Start"] = createExportWrapper(
        "FPDF_RenderPageBitmap_Start",
        9,
      );
      Module["_FPDF_RenderPage_Continue"] = createExportWrapper(
        "FPDF_RenderPage_Continue",
        2,
      );
      Module["_FPDF_RenderPage_Close"] = createExportWrapper("FPDF_RenderPage_Close", 1);
      Module["_FPDF_SaveAsCopy"] = createExportWrapper("FPDF_SaveAsCopy", 3);
      Module["_FPDF_SaveWithVersion"] = createExportWrapper("FPDF_SaveWithVersion", 4);
      Module["_FPDFText_GetCharIndexFromTextIndex"] = createExportWrapper(
        "FPDFText_GetCharIndexFromTextIndex",
        2,
      );
      Module["_FPDFText_GetTextIndexFromCharIndex"] = createExportWrapper(
        "FPDFText_GetTextIndexFromCharIndex",
        2,
      );
      Module["_FPDF_GetSignatureCount"] = createExportWrapper("FPDF_GetSignatureCount", 1);
      Module["_FPDF_GetSignatureObject"] = createExportWrapper("FPDF_GetSignatureObject", 2);
      Module["_FPDFSignatureObj_GetContents"] = createExportWrapper(
        "FPDFSignatureObj_GetContents",
        3,
      );
      Module["_FPDFSignatureObj_GetByteRange"] = createExportWrapper(
        "FPDFSignatureObj_GetByteRange",
        3,
      );
      Module["_FPDFSignatureObj_GetSubFilter"] = createExportWrapper(
        "FPDFSignatureObj_GetSubFilter",
        3,
      );
      Module["_FPDFSignatureObj_GetReason"] = createExportWrapper(
        "FPDFSignatureObj_GetReason",
        3,
      );
      Module["_FPDFSignatureObj_GetTime"] = createExportWrapper(
        "FPDFSignatureObj_GetTime",
        3,
      );
      Module["_FPDFSignatureObj_GetDocMDPPermission"] = createExportWrapper(
        "FPDFSignatureObj_GetDocMDPPermission",
        1,
      );
      Module["_FPDF_StructTree_GetForPage"] = createExportWrapper(
        "FPDF_StructTree_GetForPage",
        1,
      );
      Module["_FPDF_StructTree_Close"] = createExportWrapper("FPDF_StructTree_Close", 1);
      Module["_FPDF_StructTree_CountChildren"] = createExportWrapper(
        "FPDF_StructTree_CountChildren",
        1,
      );
      Module["_FPDF_StructTree_GetChildAtIndex"] = createExportWrapper(
        "FPDF_StructTree_GetChildAtIndex",
        2,
      );
      Module["_FPDF_StructElement_GetAltText"] = createExportWrapper(
        "FPDF_StructElement_GetAltText",
        3,
      );
      Module["_FPDF_StructElement_GetActualText"] = createExportWrapper(
        "FPDF_StructElement_GetActualText",
        3,
      );
      Module["_FPDF_StructElement_GetID"] = createExportWrapper(
        "FPDF_StructElement_GetID",
        3,
      );
      Module["_FPDF_StructElement_GetLang"] = createExportWrapper(
        "FPDF_StructElement_GetLang",
        3,
      );
      Module["_FPDF_StructElement_GetAttributeCount"] = createExportWrapper(
        "FPDF_StructElement_GetAttributeCount",
        1,
      );
      Module["_FPDF_StructElement_GetAttributeAtIndex"] = createExportWrapper(
        "FPDF_StructElement_GetAttributeAtIndex",
        2,
      );
      Module["_FPDF_StructElement_GetStringAttribute"] = createExportWrapper(
        "FPDF_StructElement_GetStringAttribute",
        4,
      );
      Module["_FPDF_StructElement_GetMarkedContentID"] = createExportWrapper(
        "FPDF_StructElement_GetMarkedContentID",
        1,
      );
      Module["_FPDF_StructElement_GetType"] = createExportWrapper(
        "FPDF_StructElement_GetType",
        3,
      );
      Module["_FPDF_StructElement_GetObjType"] = createExportWrapper(
        "FPDF_StructElement_GetObjType",
        3,
      );
      Module["_FPDF_StructElement_GetTitle"] = createExportWrapper(
        "FPDF_StructElement_GetTitle",
        3,
      );
      Module["_FPDF_StructElement_CountChildren"] = createExportWrapper(
        "FPDF_StructElement_CountChildren",
        1,
      );
      Module["_FPDF_StructElement_GetChildAtIndex"] = createExportWrapper(
        "FPDF_StructElement_GetChildAtIndex",
        2,
      );
      Module["_FPDF_StructElement_GetChildMarkedContentID"] = createExportWrapper("FPDF_StructElement_GetChildMarkedContentID", 2);
      Module["_FPDF_StructElement_GetParent"] = createExportWrapper(
        "FPDF_StructElement_GetParent",
        1,
      );
      Module["_FPDF_StructElement_Attr_GetCount"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetCount",
        1,
      );
      Module["_FPDF_StructElement_Attr_GetName"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetName",
        5,
      );
      Module["_FPDF_StructElement_Attr_GetValue"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetValue",
        2,
      );
      Module["_FPDF_StructElement_Attr_GetType"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetType",
        1,
      );
      Module["_FPDF_StructElement_Attr_GetBooleanValue"] = createExportWrapper("FPDF_StructElement_Attr_GetBooleanValue", 2);
      Module["_FPDF_StructElement_Attr_GetNumberValue"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetNumberValue",
        2,
      );
      Module["_FPDF_StructElement_Attr_GetStringValue"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetStringValue",
        4,
      );
      Module["_FPDF_StructElement_Attr_GetBlobValue"] = createExportWrapper(
        "FPDF_StructElement_Attr_GetBlobValue",
        4,
      );
      Module["_FPDF_StructElement_Attr_CountChildren"] = createExportWrapper(
        "FPDF_StructElement_Attr_CountChildren",
        1,
      );
      Module["_FPDF_StructElement_Attr_GetChildAtIndex"] = createExportWrapper("FPDF_StructElement_Attr_GetChildAtIndex", 2);
      Module["_FPDF_StructElement_GetMarkedContentIdCount"] = createExportWrapper("FPDF_StructElement_GetMarkedContentIdCount", 1);
      Module["_FPDF_StructElement_GetMarkedContentIdAtIndex"] = createExportWrapper("FPDF_StructElement_GetMarkedContentIdAtIndex", 2);
      Module["_FPDF_AddInstalledFont"] = createExportWrapper("FPDF_AddInstalledFont", 3);
      Module["_FPDF_SetSystemFontInfo"] = createExportWrapper("FPDF_SetSystemFontInfo", 1);
      Module["_FPDF_GetDefaultTTFMap"] = createExportWrapper("FPDF_GetDefaultTTFMap", 0);
      Module["_FPDF_GetDefaultTTFMapCount"] = createExportWrapper(
        "FPDF_GetDefaultTTFMapCount",
        0,
      );
      Module["_FPDF_GetDefaultTTFMapEntry"] = createExportWrapper(
        "FPDF_GetDefaultTTFMapEntry",
        1,
      );
      Module["_FPDF_GetDefaultSystemFontInfo"] = createExportWrapper(
        "FPDF_GetDefaultSystemFontInfo",
        0,
      );
      Module["_FPDF_FreeDefaultSystemFontInfo"] = createExportWrapper(
        "FPDF_FreeDefaultSystemFontInfo",
        1,
      );
      Module["_FPDFText_LoadPage"] = createExportWrapper("FPDFText_LoadPage", 1);
      Module["_FPDFText_ClosePage"] = createExportWrapper("FPDFText_ClosePage", 1);
      Module["_FPDFText_CountChars"] = createExportWrapper("FPDFText_CountChars", 1);
      Module["_FPDFText_GetUnicode"] = createExportWrapper("FPDFText_GetUnicode", 2);
      Module["_FPDFText_GetTextObject"] = createExportWrapper("FPDFText_GetTextObject", 2);
      Module["_FPDFText_IsGenerated"] = createExportWrapper("FPDFText_IsGenerated", 2);
      Module["_FPDFText_IsHyphen"] = createExportWrapper("FPDFText_IsHyphen", 2);
      Module["_FPDFText_HasUnicodeMapError"] = createExportWrapper(
        "FPDFText_HasUnicodeMapError",
        2,
      );
      Module["_FPDFText_GetFontSize"] = createExportWrapper("FPDFText_GetFontSize", 2);
      Module["_FPDFText_GetFontInfo"] = createExportWrapper("FPDFText_GetFontInfo", 5);
      Module["_FPDFText_GetFontWeight"] = createExportWrapper("FPDFText_GetFontWeight", 2);
      Module["_FPDFText_GetFillColor"] = createExportWrapper("FPDFText_GetFillColor", 6);
      Module["_FPDFText_GetStrokeColor"] = createExportWrapper("FPDFText_GetStrokeColor", 6);
      Module["_FPDFText_GetCharAngle"] = createExportWrapper("FPDFText_GetCharAngle", 2);
      Module["_FPDFText_GetCharBox"] = createExportWrapper("FPDFText_GetCharBox", 6);
      Module["_FPDFText_GetLooseCharBox"] = createExportWrapper(
        "FPDFText_GetLooseCharBox",
        3,
      );
      Module["_FPDFText_GetMatrix"] = createExportWrapper("FPDFText_GetMatrix", 3);
      Module["_FPDFText_GetCharOrigin"] = createExportWrapper("FPDFText_GetCharOrigin", 4);
      Module["_FPDFText_GetCharIndexAtPos"] = createExportWrapper(
        "FPDFText_GetCharIndexAtPos",
        5,
      );
      Module["_FPDFText_GetText"] = createExportWrapper("FPDFText_GetText", 4);
      Module["_FPDFText_CountRects"] = createExportWrapper("FPDFText_CountRects", 3);
      Module["_FPDFText_GetRect"] = createExportWrapper("FPDFText_GetRect", 6);
      Module["_FPDFText_GetBoundedText"] = createExportWrapper("FPDFText_GetBoundedText", 7);
      Module["_FPDFText_FindStart"] = createExportWrapper("FPDFText_FindStart", 4);
      Module["_FPDFText_FindNext"] = createExportWrapper("FPDFText_FindNext", 1);
      Module["_FPDFText_FindPrev"] = createExportWrapper("FPDFText_FindPrev", 1);
      Module["_FPDFText_GetSchResultIndex"] = createExportWrapper(
        "FPDFText_GetSchResultIndex",
        1,
      );
      Module["_FPDFText_GetSchCount"] = createExportWrapper("FPDFText_GetSchCount", 1);
      Module["_FPDFText_FindClose"] = createExportWrapper("FPDFText_FindClose", 1);
      Module["_FPDFLink_LoadWebLinks"] = createExportWrapper("FPDFLink_LoadWebLinks", 1);
      Module["_FPDFLink_CountWebLinks"] = createExportWrapper("FPDFLink_CountWebLinks", 1);
      Module["_FPDFLink_GetURL"] = createExportWrapper("FPDFLink_GetURL", 4);
      Module["_FPDFLink_CountRects"] = createExportWrapper("FPDFLink_CountRects", 2);
      Module["_FPDFLink_GetRect"] = createExportWrapper("FPDFLink_GetRect", 7);
      Module["_FPDFLink_GetTextRange"] = createExportWrapper("FPDFLink_GetTextRange", 4);
      Module["_FPDFLink_CloseWebLinks"] = createExportWrapper("FPDFLink_CloseWebLinks", 1);
      Module["_FPDFPage_GetDecodedThumbnailData"] = createExportWrapper(
        "FPDFPage_GetDecodedThumbnailData",
        3,
      );
      Module["_FPDFPage_GetRawThumbnailData"] = createExportWrapper(
        "FPDFPage_GetRawThumbnailData",
        3,
      );
      Module["_FPDFPage_GetThumbnailAsBitmap"] = createExportWrapper(
        "FPDFPage_GetThumbnailAsBitmap",
        1,
      );
      Module["_FPDFPage_SetMediaBox"] = createExportWrapper("FPDFPage_SetMediaBox", 5);
      Module["_FPDFPage_SetCropBox"] = createExportWrapper("FPDFPage_SetCropBox", 5);
      Module["_FPDFPage_SetBleedBox"] = createExportWrapper("FPDFPage_SetBleedBox", 5);
      Module["_FPDFPage_SetTrimBox"] = createExportWrapper("FPDFPage_SetTrimBox", 5);
      Module["_FPDFPage_SetArtBox"] = createExportWrapper("FPDFPage_SetArtBox", 5);
      Module["_FPDFPage_GetMediaBox"] = createExportWrapper("FPDFPage_GetMediaBox", 5);
      Module["_FPDFPage_GetCropBox"] = createExportWrapper("FPDFPage_GetCropBox", 5);
      Module["_FPDFPage_GetBleedBox"] = createExportWrapper("FPDFPage_GetBleedBox", 5);
      Module["_FPDFPage_GetTrimBox"] = createExportWrapper("FPDFPage_GetTrimBox", 5);
      Module["_FPDFPage_GetArtBox"] = createExportWrapper("FPDFPage_GetArtBox", 5);
      Module["_FPDFPage_TransFormWithClip"] = createExportWrapper(
        "FPDFPage_TransFormWithClip",
        3,
      );
      Module["_FPDFPageObj_TransformClipPath"] = createExportWrapper(
        "FPDFPageObj_TransformClipPath",
        7,
      );
      Module["_FPDFPageObj_GetClipPath"] = createExportWrapper("FPDFPageObj_GetClipPath", 1);
      Module["_FPDFClipPath_CountPaths"] = createExportWrapper("FPDFClipPath_CountPaths", 1);
      Module["_FPDFClipPath_CountPathSegments"] = createExportWrapper(
        "FPDFClipPath_CountPathSegments",
        2,
      );
      Module["_FPDFClipPath_GetPathSegment"] = createExportWrapper(
        "FPDFClipPath_GetPathSegment",
        3,
      );
      Module["_FPDF_CreateClipPath"] = createExportWrapper("FPDF_CreateClipPath", 4);
      Module["_FPDF_DestroyClipPath"] = createExportWrapper("FPDF_DestroyClipPath", 1);
      Module["_FPDFPage_InsertClipPath"] = createExportWrapper("FPDFPage_InsertClipPath", 2);
      Module["_FPDF_InitLibrary"] = createExportWrapper("FPDF_InitLibrary", 0);
      Module["_malloc"] = createExportWrapper("malloc", 1);
      Module["_free"] = createExportWrapper("free", 1);
      Module["_FPDF_DestroyLibrary"] = createExportWrapper("FPDF_DestroyLibrary", 0);
      Module["_FPDF_SetSandBoxPolicy"] = createExportWrapper("FPDF_SetSandBoxPolicy", 2);
      Module["_FPDF_LoadDocument"] = createExportWrapper("FPDF_LoadDocument", 2);
      Module["_FPDF_GetFormType"] = createExportWrapper("FPDF_GetFormType", 1);
      Module["_FPDF_LoadXFA"] = createExportWrapper("FPDF_LoadXFA", 1);
      Module["_FPDF_LoadMemDocument"] = createExportWrapper("FPDF_LoadMemDocument", 3);
      Module["_FPDF_LoadMemDocument64"] = createExportWrapper("FPDF_LoadMemDocument64", 3);
      Module["_FPDF_LoadCustomDocument"] = createExportWrapper("FPDF_LoadCustomDocument", 2);
      Module["_FPDF_GetFileVersion"] = createExportWrapper("FPDF_GetFileVersion", 2);
      Module["_FPDF_DocumentHasValidCrossReferenceTable"] = createExportWrapper("FPDF_DocumentHasValidCrossReferenceTable", 1);
      Module["_FPDF_GetDocPermissions"] = createExportWrapper("FPDF_GetDocPermissions", 1);
      Module["_FPDF_GetDocUserPermissions"] = createExportWrapper(
        "FPDF_GetDocUserPermissions",
        1,
      );
      Module["_FPDF_GetSecurityHandlerRevision"] = createExportWrapper(
        "FPDF_GetSecurityHandlerRevision",
        1,
      );
      Module["_FPDF_GetPageCount"] = createExportWrapper("FPDF_GetPageCount", 1);
      Module["_FPDF_LoadPage"] = createExportWrapper("FPDF_LoadPage", 2);
      Module["_FPDF_GetPageWidthF"] = createExportWrapper("FPDF_GetPageWidthF", 1);
      Module["_FPDF_GetPageWidth"] = createExportWrapper("FPDF_GetPageWidth", 1);
      Module["_FPDF_GetPageHeightF"] = createExportWrapper("FPDF_GetPageHeightF", 1);
      Module["_FPDF_GetPageHeight"] = createExportWrapper("FPDF_GetPageHeight", 1);
      Module["_FPDF_GetPageBoundingBox"] = createExportWrapper("FPDF_GetPageBoundingBox", 2);
      Module["_FPDF_RenderPageBitmap"] = createExportWrapper("FPDF_RenderPageBitmap", 8);
      Module["_FPDF_RenderPageBitmapWithMatrix"] = createExportWrapper(
        "FPDF_RenderPageBitmapWithMatrix",
        5,
      );
      Module["_FPDF_ClosePage"] = createExportWrapper("FPDF_ClosePage", 1);
      Module["_FPDF_CloseDocument"] = createExportWrapper("FPDF_CloseDocument", 1);
      Module["_FPDF_GetLastError"] = createExportWrapper("FPDF_GetLastError", 0);
      Module["_FPDF_DeviceToPage"] = createExportWrapper("FPDF_DeviceToPage", 10);
      Module["_FPDF_PageToDevice"] = createExportWrapper("FPDF_PageToDevice", 10);
      Module["_FPDFBitmap_Create"] = createExportWrapper("FPDFBitmap_Create", 3);
      Module["_FPDFBitmap_CreateEx"] = createExportWrapper("FPDFBitmap_CreateEx", 5);
      Module["_FPDFBitmap_GetFormat"] = createExportWrapper("FPDFBitmap_GetFormat", 1);
      Module["_FPDFBitmap_FillRect"] = createExportWrapper("FPDFBitmap_FillRect", 6);
      Module["_FPDFBitmap_GetBuffer"] = createExportWrapper("FPDFBitmap_GetBuffer", 1);
      Module["_FPDFBitmap_GetWidth"] = createExportWrapper("FPDFBitmap_GetWidth", 1);
      Module["_FPDFBitmap_GetHeight"] = createExportWrapper("FPDFBitmap_GetHeight", 1);
      Module["_FPDFBitmap_GetStride"] = createExportWrapper("FPDFBitmap_GetStride", 1);
      Module["_FPDFBitmap_Destroy"] = createExportWrapper("FPDFBitmap_Destroy", 1);
      Module["_FPDF_GetPageSizeByIndexF"] = createExportWrapper(
        "FPDF_GetPageSizeByIndexF",
        3,
      );
      Module["_FPDF_GetPageSizeByIndex"] = createExportWrapper("FPDF_GetPageSizeByIndex", 4);
      Module["_FPDF_VIEWERREF_GetPrintScaling"] = createExportWrapper(
        "FPDF_VIEWERREF_GetPrintScaling",
        1,
      );
      Module["_FPDF_VIEWERREF_GetNumCopies"] = createExportWrapper(
        "FPDF_VIEWERREF_GetNumCopies",
        1,
      );
      Module["_FPDF_VIEWERREF_GetPrintPageRange"] = createExportWrapper(
        "FPDF_VIEWERREF_GetPrintPageRange",
        1,
      );
      Module["_FPDF_VIEWERREF_GetPrintPageRangeCount"] = createExportWrapper(
        "FPDF_VIEWERREF_GetPrintPageRangeCount",
        1,
      );
      Module["_FPDF_VIEWERREF_GetPrintPageRangeElement"] = createExportWrapper("FPDF_VIEWERREF_GetPrintPageRangeElement", 2);
      Module["_FPDF_VIEWERREF_GetDuplex"] = createExportWrapper(
        "FPDF_VIEWERREF_GetDuplex",
        1,
      );
      Module["_FPDF_VIEWERREF_GetName"] = createExportWrapper("FPDF_VIEWERREF_GetName", 4);
      Module["_FPDF_CountNamedDests"] = createExportWrapper("FPDF_CountNamedDests", 1);
      Module["_FPDF_GetNamedDestByName"] = createExportWrapper("FPDF_GetNamedDestByName", 2);
      Module["_FPDF_GetNamedDest"] = createExportWrapper("FPDF_GetNamedDest", 4);
      Module["_FPDF_GetXFAPacketCount"] = createExportWrapper("FPDF_GetXFAPacketCount", 1);
      Module["_FPDF_GetXFAPacketName"] = createExportWrapper("FPDF_GetXFAPacketName", 4);
      Module["_FPDF_GetXFAPacketContent"] = createExportWrapper(
        "FPDF_GetXFAPacketContent",
        5,
      );
      Module["_FPDF_GetTrailerEnds"] = createExportWrapper("FPDF_GetTrailerEnds", 3);
      _fflush = createExportWrapper("fflush", 1);
      _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
      wasmExports["emscripten_stack_get_base"];
      _emscripten_builtin_memalign = createExportWrapper("emscripten_builtin_memalign", 2);
      _strerror = createExportWrapper("strerror", 1);
      _setThrew = createExportWrapper("setThrew", 2);
      _emscripten_stack_init = wasmExports["emscripten_stack_init"];
      wasmExports["emscripten_stack_get_free"];
      __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
      __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
      _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
    }
    var wasmImports = {
      __syscall_fcntl64: ___syscall_fcntl64,
      __syscall_fstat64: ___syscall_fstat64,
      __syscall_ftruncate64: ___syscall_ftruncate64,
      __syscall_getdents64: ___syscall_getdents64,
      __syscall_ioctl: ___syscall_ioctl,
      __syscall_lstat64: ___syscall_lstat64,
      __syscall_newfstatat: ___syscall_newfstatat,
      __syscall_openat: ___syscall_openat,
      __syscall_rmdir: ___syscall_rmdir,
      __syscall_stat64: ___syscall_stat64,
      __syscall_unlinkat: ___syscall_unlinkat,
      _abort_js: __abort_js,
      _emscripten_throw_longjmp: __emscripten_throw_longjmp,
      _gmtime_js: __gmtime_js,
      _localtime_js: __localtime_js,
      _tzset_js: __tzset_js,
      emscripten_date_now: _emscripten_date_now,
      emscripten_resize_heap: _emscripten_resize_heap,
      environ_get: _environ_get,
      environ_sizes_get: _environ_sizes_get,
      fd_close: _fd_close,
      fd_read: _fd_read,
      fd_seek: _fd_seek,
      fd_sync: _fd_sync,
      fd_write: _fd_write,
      invoke_ii,
      invoke_iii,
      invoke_iiii,
      invoke_iiiii,
      invoke_v,
      invoke_viii,
      invoke_viiii,
    };
    var wasmExports = await createWasm();
    function invoke_viii(index, a1, a2, a3) {
      var sp = stackSave();
      try {
        getWasmTableEntry(index)(a1, a2, a3);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_ii(index, a1) {
      var sp = stackSave();
      try {
        return getWasmTableEntry(index)(a1);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_iii(index, a1, a2) {
      var sp = stackSave();
      try {
        return getWasmTableEntry(index)(a1, a2);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_iiii(index, a1, a2, a3) {
      var sp = stackSave();
      try {
        return getWasmTableEntry(index)(a1, a2, a3);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_viiii(index, a1, a2, a3, a4) {
      var sp = stackSave();
      try {
        getWasmTableEntry(index)(a1, a2, a3, a4);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_iiiii(index, a1, a2, a3, a4) {
      var sp = stackSave();
      try {
        return getWasmTableEntry(index)(a1, a2, a3, a4);
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    function invoke_v(index) {
      var sp = stackSave();
      try {
        getWasmTableEntry(index)();
      } catch (e) {
        stackRestore(sp);
        if (e !== e + 0) throw e;
        _setThrew(1, 0);
      }
    }
    var calledRun;
    function stackCheckInit() {
      _emscripten_stack_init();
      writeStackCookie();
    }
    function run() {
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      stackCheckInit();
      preRun();
      if (runDependencies > 0) {
        dependenciesFulfilled = run;
        return;
      }
      function doRun() {
        assert(!calledRun);
        calledRun = true;
        Module["calledRun"] = true;
        if (ABORT) return;
        initRuntime();
        readyPromiseResolve?.(Module);
        Module["onRuntimeInitialized"]?.();
        consumedModuleProp("onRuntimeInitialized");
        assert(
          !Module["_main"],
          'compiled without a main, but one is present. if you added it from JS, use Module["onRuntimeInitialized"]',
        );
        postRun();
      }
      if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout(() => {
          setTimeout(() => Module["setStatus"](""), 1);
          doRun();
        }, 1);
      } else {
        doRun();
      }
      checkStackCookie();
    }
    function preInit() {
      if (Module["preInit"]) {
        if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
        while (Module["preInit"].length > 0) {
          Module["preInit"].shift()();
        }
      }
      consumedModuleProp("preInit");
    }
    preInit();
    run();
    if (runtimeInitialized) {
      moduleRtn = Module;
    } else {
      moduleRtn = new Promise((resolve, reject) => {
        readyPromiseResolve = resolve;
        readyPromiseReject = reject;
      });
    }
    for (const prop of Object.keys(Module)) {
      if (!(prop in moduleArg)) {
        Object.defineProperty(moduleArg, prop, {
          configurable: true,
          get() {
            abort(
              `Access to module property ('${prop}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`,
            );
          },
        });
      }
    }

    return moduleRtn;
  };
})();

class PDFiumLibrary extends PDFiumLibrary$1 {
    static init(options) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield PDFiumLibrary$1.initBase({
                vendor: PDFiumModule,
                wasmBinary: options === null || options === void 0 ? void 0 : options.wasmBinary,
                wasmUrl: options === null || options === void 0 ? void 0 : options.wasmUrl,
                instantiateWasm: options === null || options === void 0 ? void 0 : options.instantiateWasm,
            });
        });
    }
}

export { PDFiumDocument, PDFiumFormObject, PDFiumImageObject, PDFiumLibrary, PDFiumModule, PDFiumPage, PDFiumPathObject, PDFiumShadingObject, PDFiumTextObject };
