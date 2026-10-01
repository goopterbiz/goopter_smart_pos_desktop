import { describe, expect, it } from "vitest";
import { kioskAtLaunch, parseSettings } from "../../src/bridge/settings.js";

/** C5: the saved window mode. Only a boolean false leaves kiosk mode. */
describe("settings", () => {
  it("reads {\"kiosk\": false} as windowed", () => {
    expect(parseSettings('{"kiosk":false}')).toEqual({ kiosk: false });
    expect(parseSettings(' { "kiosk" : false , "other": 1 } ')).toEqual({ kiosk: false });
  });

  it("reads {\"kiosk\": true} as kiosk", () => {
    expect(parseSettings('{"kiosk":true}')).toEqual({ kiosk: true });
  });

  it("reads a missing file as kiosk", () => {
    expect(parseSettings(undefined)).toEqual({ kiosk: true });
    expect(parseSettings(null)).toEqual({ kiosk: true });
  });

  it("reads malformed JSON as kiosk", () => {
    for (const raw of ["", "{", '{"kiosk":false', "kiosk=false", "\u0000"]) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: true });
    }
  });

  it("reads a kiosk value that is not a boolean as kiosk", () => {
    for (const raw of ['{"kiosk":"true"}', '{"kiosk":"false"}', '{"kiosk":1}', '{"kiosk":0}', '{"kiosk":null}', "{}"]) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: true });
    }
  });

  it("reads a document that is not an object as kiosk", () => {
    for (const raw of ["false", "0", "null", '"kiosk"', "[false]", '[{"kiosk":false}]']) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: true });
    }
  });

  it("reads anything that is not file text as kiosk", () => {
    for (const raw of [{ kiosk: false }, false, 0, []]) {
      expect(parseSettings(raw)).toEqual({ kiosk: true });
    }
  });

  it("the dev override wins over the saved setting, which wins over kiosk", () => {
    expect(kioskAtLaunch({ windowedOverride: true, saved: { kiosk: true } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: true, saved: { kiosk: false } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: false, saved: { kiosk: false } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: false, saved: parseSettings(undefined) })).toBe(true);
  });
});
