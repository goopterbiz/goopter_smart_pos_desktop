import { describe, expect, it } from "vitest";
import { Destination, validateDestination } from "../../src/bridge/destination.js";
import { JobFailure } from "../../src/bridge/jobFailure.js";

/** SPEC §8.1, Android DestinationPolicyTests D1-D12. */
describe("DestinationPolicy", () => {
  const validate = (host: string | null, port: number | null = 9100): Destination =>
    validateDestination(host, port === null ? null : String(port));

  const refusal = (host: string | null, port: number | null = 9100): JobFailure => {
    try {
      validate(host, port);
    } catch (error) {
      if (error instanceof JobFailure) return error;
      throw error;
    }
    throw new Error(`expected ${host}:${port} to be refused`);
  };

  it("D1 admits every permitted range", () => {
    for (const host of [
      "10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254",
      "192.168.0.1", "192.168.255.254", "169.254.1.1",
    ]) {
      expect(validate(host).host).toBe(host);
    }
  });

  it("D2 refuses addresses just outside the ranges", () => {
    for (const host of ["9.255.255.255", "11.0.0.1", "172.15.0.1", "172.32.0.1",
      "192.167.0.1", "192.169.0.1", "169.253.0.1", "169.255.0.1"]) {
      expect(refusal(host)).toEqual(JobFailure.hostNotLocal(host));
    }
  });

  it("D3 refuses hostnames", () => {
    for (const host of ["printer.local", "goopter-iotbox.local", "localhost", "kitchen"]) {
      expect(refusal(host)).toEqual(JobFailure.hostNotLocal(host));
    }
  });

  it("D4 refuses public, loopback, multicast and broadcast", () => {
    for (const host of ["8.8.8.8", "127.0.0.1", "224.0.0.1", "239.1.1.1", "255.255.255.255", "0.0.0.0"]) {
      expect(refusal(host)).toEqual(JobFailure.hostNotLocal(host));
    }
  });

  it("D5 refuses IPv6", () => {
    for (const host of ["::1", "fe80::1", "fd00::1", "2001:db8::1"]) {
      expect(refusal(host)).toEqual(JobFailure.hostNotLocal(host));
    }
  });

  it("D6 refuses malformed dotted quads", () => {
    for (const host of ["010.0.0.1", "10.0.0", "10.0.0.1.5", "10.0.0.256", "10.0..1",
      "10.0.0.-1", "10.0 .0.1", "1e1.0.0.1", "0x0a.0.0.1", "１0.0.0.1"]) {
      expect(refusal(host).kind).toBe("hostNotLocal");
    }
  });

  it("D7 trims surrounding whitespace", () => {
    for (const host of ["10.0.0.1 ", " 10.0.0.1", "\n10.0.0.1\n", "\t10.0.0.1"]) {
      expect(validate(host).host).toBe("10.0.0.1");
    }
  });

  it("D8 a missing host is its own failure", () => {
    expect(refusal(null)).toEqual(JobFailure.missingHost());
    expect(refusal("  ")).toEqual(JobFailure.missingHost());
    expect(JobFailure.missingHost().message).toBe("No printer address was supplied.");
  });

  it("D9 admits every printing port", () => {
    for (const port of [9100, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108, 9109, 515, 631]) {
      expect(validate("10.0.0.1", port).port).toBe(port);
    }
  });

  it("D10 refuses every other port", () => {
    for (const port of [22, 80, 443, 3306, 9110, 9099, 0, 65536, -1]) {
      expect(refusal("10.0.0.1", port)).toEqual(JobFailure.portNotAllowed("10.0.0.1", String(port)));
    }
  });

  it("refuses a port that is not plain decimal", () => {
    for (const port of ["09100", "+9100", "9100.0", "9100.5", "1e2", " 9100", ""]) {
      expect(() => validateDestination("10.0.0.1", port)).toThrow(JobFailure.portNotAllowed("10.0.0.1", port).message);
    }
  });

  it("D11 reports the host before the port", () => {
    expect(refusal("8.8.8.8", 22)).toEqual(JobFailure.hostNotLocal("8.8.8.8"));
  });

  it("D12 a missing port is distinct from a refused one", () => {
    const missing = refusal("10.0.0.1", null);
    expect(missing).toEqual(JobFailure.portNotAllowed("10.0.0.1", null));
    expect(missing.outcomeKey).toBe("missing_port");
    expect(missing.message).toBe("No printer port was supplied. Check the printer's port in Odoo.");
    expect(refusal("10.0.0.1", 22).outcomeKey).toBe("port_not_allowed");
  });

  it("names the destination host:port", () => {
    expect(validate(" 172.20.1.9 ", 631).toString()).toBe("172.20.1.9:631");
  });
});
