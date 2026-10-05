# USB printing through the desktop bridge

Status: approved 2026-10-05.

## Goal

An Odoo printer can name a printer installed on the till (USB or any other OS printer queue), the
same way the QZ Tray delivery does today, and Smart POS Desktop sends the job to it. QZ Tray is no
longer needed on that till. iOS and Android do not support this delivery.

## Odoo side (`goopter_odoo_docker/addons/goopter_pos_escpos_agent`)

1. `models/pos_printer.py:33-59`: add `escpos_delivery` value `usb`, label "USB (Smart POS
   Desktop)".
2. Reuse `escpos_qz_printer_name` (`models/pos_printer.py:78`) as the printer name for `usb`, so
   switching a printer from `qz` to `usb` keeps its name. Show it in the form for both values.
   Required for `usb`: unlike QZ, there is no default printer.
3. `escpos_printer.js:319` `_deliverBytes`: for `usb`, call
   `GoopterPOS.print({ protocol_version: 2, printer: { name }, data_base64 })` with the same bytes
   the `qz` path renders.
4. Before calling, require `GoopterPOS.usbPrinting === true`. Otherwise fail the job with "This
   printer is set to USB, which needs the Goopter Smart POS desktop app, version 1.1 or later." No
   fallback to QZ Tray or the server.
5. The backend Test Connection button (`escpos_test_connection.js:138`) uses the same path.

## Bridge contract

Protocol version stays 2. The envelope gains a second printer shape. Exactly one shape per call:

```js
{ protocol_version: 2, printer: { host: "10.0.0.50", port: 9100 }, data_base64 }  // TCP, unchanged
{ protocol_version: 2, printer: { name: "EPSON_TM_T20III" },    data_base64 }  // installed printer
```

- Smart POS Desktop adds `GoopterPOS.usbPrinting: true`. iOS and Android do not have the property,
  so they need no change. Like the missing `goopterPrinter` on desktop, this is a documented
  platform difference in the bridge shape.
- A `name` key selects the installed-printer shape. Without it, the TCP rules apply unchanged.
- A printer object holding both `host` and `name` is refused. A `name` that is not a string is a
  malformed call and rejects. An empty name is refused as `missing_printer_name`.
- Responses and the rule that only a malformed call rejects are unchanged.

## Desktop app

### Validation (`src/bridge/`, before queueing)

- `name` must exactly match a printer from `webContents.getPrintersAsync()`. This also stops a name
  from being read as a command-line option. A list that cannot be read counts as empty.
- An empty name is refused before the list is read. There is no default printer.

### Delivery (OS print queue, raw mode)

| OS | How |
|---|---|
| Linux, macOS | `lp -d <name> -o raw`, started without a shell, bytes on stdin. Exit 0 = written. Linux needs `cups-client`. |
| Windows | Bundled helper `rawprint.exe` (`native/rawprint/rawprint.c`, built with mingw-w64) in `extraResources`: `OpenPrinter`, `StartDocPrinter` with datatype `RAW`, `WritePrinter`. Bytes on stdin. |

"Written" means the spooler accepted the job, not that paper moved, matching the TCP definition.

### Limits and logging

- Gate key is `name:<printer>`: one job per printer, 4 in flight overall, 12 s whole job. The 5 s
  connect timeout does not apply. The deadline kills the `lp` or helper process.
- Log `target` is the printer name. Payload bytes are never logged.
- A USB result never feeds the macOS Local Network heuristic (SPEC §8.2).

### New failures (shown verbatim to the cashier)

| Key | Message |
|---|---|
| `missing_printer_name` | No printer name was supplied. Check the printer name in Odoo. |
| `printer_not_installed` | No printer named "X" is installed on this computer. Check the printer name in Odoo. |
| `spooler_refused` | This computer's print system refused the job for "X". Check the printer in system settings. |
| `spooler_timed_out` | This computer's print system did not take the job for "X" in time. Check the printer in system settings. |
| `ambiguous_printer` | The printer setting has both an address and a name. Check the printer in Odoo. |

## Tests

- Unit (`test/unit/`): envelope name shape, name matching (exact, case, empty, names starting with
  `-`), empty-name refusal, host-and-name refusal, failure messages, deadline killing a stuck
  spooler process (fake transport).
- e2e: `GoopterPOS.usbPrinting` is `true`; a call with an unknown name returns
  `printer_not_installed`.
- Odoo: `usb` delivery without `usbPrinting` fails with the desktop-app message and sends nothing.
- Device: a receipt prints on a USB ESC/POS printer on Linux, Windows and macOS. Cash drawer kick
  works.

## Known risks

- The printer list gets 2 s (`PRINTER_LIST_TIMEOUT_MS`) before the 12 s job deadline starts, so a
  named job answers within the client's 15 s. A print system that cannot list in time reports
  `printer_not_installed`.
- A job killed by the deadline after the spooler started may still print, and is reported
  `spooler_timed_out`. On Windows, what the spooler does with a job whose `rawprint.exe` was
  terminated mid-write is unverified. Check it on a device.
- No unit test forces a spooler to exit 0 in the same instant the deadline fires. The transport
  settles from the exit code in that case, but only code reading proves it.

## Decisions

- D1. New `escpos_delivery` value `usb`, desktop only, reusing `escpos_qz_printer_name`.
- D2. Protocol version stays 2. Odoo detects support with `GoopterPOS.usbPrinting`.
- D3. No QZ Tray fallback.
- D4. Windows uses a small bundled C helper rather than an npm native printer module.
