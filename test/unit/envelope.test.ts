import { describe, expect, it } from "vitest";
import { readEnvelope, successResponse, failureResponse } from "../../src/bridge/envelope.js";
import { JobFailure, MalformedCall } from "../../src/bridge/jobFailure.js";
import { envelope, namedEnvelope, PAYLOAD } from "./support.js";

/** SPEC §3.2, §4.1, Android EnvelopeTests E1-E8, W1, W2. */
describe("EnvelopeReader", () => {
  const refusal = (body: unknown): JobFailure => {
    try {
      readEnvelope(body);
    } catch (error) {
      if (error instanceof JobFailure) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("E1 accepts a valid v2 envelope", () => {
    const parsed = readEnvelope(envelope());
    expect(parsed.destination?.host).toBe("192.168.1.50");
    expect(parsed.destination?.port).toBe(9100);
    expect(parsed.printerName).toBeUndefined();
    expect(parsed.data).toEqual(PAYLOAD);
  });

  describe("installed printer", () => {
    it("a name selects an installed printer instead of an address", () => {
      const parsed = readEnvelope(namedEnvelope());
      expect(parsed.printerName).toBe("EPSON_TM_T20III");
      expect(parsed.destination).toBeUndefined();
      expect(parsed.data).toEqual(PAYLOAD);
    });

    it("an empty name is refused before the data is read", () => {
      expect(refusal({ ...namedEnvelope({ name: "" }), data_base64: "" })).toEqual(JobFailure.missingPrinterName());
    });

    it("a name and an address together are refused before the data is read", () => {
      expect(refusal({ ...namedEnvelope({ name: "EPSON", host: "192.168.1.50", port: 9100 }), data_base64: "" }))
        .toEqual(JobFailure.ambiguousPrinter());
      expect(refusal(namedEnvelope({ name: "EPSON", host: "" }))).toEqual(JobFailure.ambiguousPrinter());
    });

    it("a name that is not a string is a malformed call", () => {
      for (const name of [null, 7, ["EPSON"], { name: "EPSON" }]) {
        expect(() => readEnvelope(namedEnvelope({ name }))).toThrow(MalformedCall);
      }
    });

    it("still checks the version first and the data last", () => {
      expect(refusal({ ...namedEnvelope(), protocol_version: 3 })).toEqual(JobFailure.unsupportedVersion("3"));
      expect(refusal({ ...namedEnvelope(), data_base64: "" })).toEqual(JobFailure.noData());
    });
  });

  it("E2 a non-object body is a malformed call, not a JobFailure", () => {
    for (const body of ["not an envelope", null, undefined, [1, 2, 3], 42]) {
      expect(() => readEnvelope(body)).toThrow(MalformedCall);
    }
  });

  it("E3 refuses an unknown protocol version", () => {
    for (const version of [1, 3, 99]) {
      expect(refusal(envelope({ version }))).toEqual(JobFailure.unsupportedVersion(String(version)));
    }
  });

  it("E4 refuses a missing protocol version", () => {
    const failure = refusal(envelope({ version: null }));
    expect(failure).toEqual(JobFailure.unsupportedVersion(null));
    expect(failure.message).toBe("This app speaks print protocol 2; the page sent none. Update the app.");
  });

  it("E5 checks the version before printer or data", () => {
    expect(refusal({ protocol_version: 0 })).toEqual(JobFailure.unsupportedVersion("0"));
  });

  it("E6 ignores unrecognised keys", () => {
    expect(readEnvelope({ ...envelope(), invented_later: ["anything"] }).destination?.port).toBe(9100);
  });

  it("E7 refuses missing, empty and undecodable data", () => {
    for (const base64 of [null, "", "not base64 !!", "A", 12, "G0Bo aQodVgA=", "G0BoaQodVgA=\n", "G0BoaQodVgA=="]) {
      expect(refusal(envelope({ base64 }))).toEqual(JobFailure.noData());
    }
  });

  it("E8 a padding-only payload is not a print job", () => {
    expect(refusal(envelope({ base64: "====" }))).toEqual(JobFailure.noData());
  });

  it("accepts unpadded base64 that decodes to whole bytes", () => {
    expect(readEnvelope(envelope({ base64: "G0BoaQodVgA" })).data).toEqual(PAYLOAD);
  });

  it("W1 a fractional version is refused", () => {
    expect(refusal(envelope({ version: 2.7 }))).toEqual(JobFailure.unsupportedVersion("2.7"));
  });

  it("a version that is not a number counts as none", () => {
    for (const version of ["2", true, [2], { v: 2 }]) {
      expect(refusal(envelope({ version }))).toEqual(JobFailure.unsupportedVersion(null));
    }
  });

  it("W2 a fractional port is refused, not truncated", () => {
    const failure = refusal(envelope({ port: 9100.5 }));
    expect(failure).toEqual(JobFailure.portNotAllowed("192.168.1.50", "9100.5"));
    expect(failure.message).toBe("Port 9100.5 is not a printing port. Check the printer's port in Odoo.");
  });

  it("a port sent as a string was not sent as a port", () => {
    expect(refusal(envelope({ port: "9100" }))).toEqual(JobFailure.portNotAllowed("192.168.1.50", null));
  });

  it("checks the destination before the data", () => {
    expect(refusal(envelope({ host: "8.8.8.8", base64: "" }))).toEqual(JobFailure.hostNotLocal("8.8.8.8"));
  });

  it("a printer that is not an object has no host", () => {
    expect(refusal({ ...envelope(), printer: "192.168.1.50:9100" })).toEqual(JobFailure.missingHost());
  });
});

/** SPEC §3.3: absent fields are omitted, so the page sees a missing property rather than null. */
describe("PrintResponse", () => {
  it("a success carries bytes and no message key", () => {
    const response = successResponse(12);
    expect(response).toStrictEqual({ successful: true, bytes: 12 });
  });

  it("a failure carries the message and no bytes key", () => {
    expect(failureResponse(JobFailure.noData())).toStrictEqual({
      successful: false,
      message: "The print job contained no data.",
    });
  });
});
