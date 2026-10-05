import { describe, expect, it } from "vitest";
import { uncheckedDestination } from "../../src/bridge/destination.js";
import { resolveInstalledPrinter } from "../../src/bridge/installedPrinter.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";

/** USB_PRINTING_SPEC "Validation": the name must be a printer the OS has installed. */
describe("InstalledPrinter", () => {
  const installed = ["EPSON_TM_T20III", "Kitchen Star"];

  const refusal = (name: string, printers: string[]): JobFailure => {
    try {
      resolveInstalledPrinter(name, printers);
    } catch (error) {
      if (error instanceof JobFailure) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("accepts an exact name, spaces included", () => {
    expect(resolveInstalledPrinter("EPSON_TM_T20III", installed).name).toBe("EPSON_TM_T20III");
    expect(resolveInstalledPrinter("Kitchen Star", installed).name).toBe("Kitchen Star");
  });

  it("refuses a name that differs in case or whitespace", () => {
    for (const name of ["epson_tm_t20iii", "EPSON_TM_T20III ", " Kitchen Star"]) {
      expect(refusal(name, installed)).toEqual(JobFailure.printerNotInstalled(name));
    }
  });

  it("refuses a name that looks like a command-line option", () => {
    for (const name of ["-d", "-o raw", "--help"]) {
      expect(refusal(name, installed)).toEqual(JobFailure.printerNotInstalled(name));
    }
  });

  it("logs an installed printer by its name", () => {
    expect(resolveInstalledPrinter("Kitchen Star", installed).toString()).toBe("Kitchen Star");
  });

  it("an empty name is never an installed printer, even if the OS lists one", () => {
    expect(refusal("", ["", ...installed])).toEqual(JobFailure.missingPrinterName());
  });

  it("never shares a printer lock with a network printer", () => {
    expect(resolveInstalledPrinter("10.0.0.1:9100", ["10.0.0.1:9100"]).gateKey)
      .not.toBe(uncheckedDestination("10.0.0.1", 9100).gateKey);
  });
});
