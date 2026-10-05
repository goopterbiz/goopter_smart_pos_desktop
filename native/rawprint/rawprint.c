/*
 * rawprint: copy stdin to a Windows printer as one RAW spooler job (USB_PRINTING_SPEC "Delivery").
 *
 *   rawprint.exe <printer name>
 *
 * Exits 0 once the spooler has accepted every byte, non-zero on any failure. Never prints the
 * payload. Built with mingw-w64 by `npm run build:rawprint`.
 */
#include <windows.h>
#include <winspool.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>

/* Larger than any receipt raster, so a job that does not fit is refused rather than truncated. */
#define MAX_JOB_BYTES (16 * 1024 * 1024)

static unsigned char *read_stdin(DWORD *length) {
    unsigned char *buffer = malloc(MAX_JOB_BYTES);
    size_t total = 0, got;
    if (buffer == NULL) return NULL;
    _setmode(_fileno(stdin), _O_BINARY);
    while ((got = fread(buffer + total, 1, MAX_JOB_BYTES - total, stdin)) > 0) {
        total += got;
        if (total == MAX_JOB_BYTES) { free(buffer); return NULL; }
    }
    if (ferror(stdin) || total == 0) { free(buffer); return NULL; }
    *length = (DWORD)total;
    return buffer;
}

int wmain(int argc, wchar_t **argv) {
    const wchar_t *name;
    HANDLE printer;
    DOC_INFO_1W doc = { L"Odoo POS", NULL, L"RAW" };
    DWORD length, written = 0;
    unsigned char *data;
    int ok;

    /* Exactly one non-empty printer name. There is no default printer. */
    if (argc != 2 || argv[1][0] == L'\0') return 2;
    name = argv[1];

    data = read_stdin(&length);
    if (data == NULL) return 4;

    if (!OpenPrinterW((wchar_t *)name, &printer, NULL)) { free(data); return 5; }
    ok = StartDocPrinterW(printer, 1, (BYTE *)&doc) != 0;
    if (ok) {
        DWORD total = 0;
        ok = StartPagePrinter(printer);
        /* WritePrinter may take fewer bytes than offered. */
        while (ok && total < length) {
            ok = WritePrinter(printer, data + total, length - total, &written) && written > 0;
            total += written;
        }
        ok = ok && EndPagePrinter(printer);
        if (ok) {
            ok = EndDocPrinter(printer);
        } else {
            /* A job that did not write fully is deleted rather than released half printed. */
            AbortPrinter(printer);
        }
    }
    ClosePrinter(printer);
    free(data);
    return ok ? 0 : 6;
}
