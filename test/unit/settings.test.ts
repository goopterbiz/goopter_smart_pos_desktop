import { describe, expect, it } from "vitest";
import { kioskAtLaunch, parseSettings } from "../../src/bridge/settings.js";

/** C5: the saved window mode. Only a boolean true enters kiosk mode. */
describe("settings", () => {
  it("reads {\"kiosk\": false} as windowed", () => {
    expect(parseSettings('{"kiosk":false}')).toEqual({ kiosk: false });
    expect(parseSettings(' { "kiosk" : false , "other": 1 } ')).toEqual({ kiosk: false });
  });

  it("reads {\"kiosk\": true} as kiosk", () => {
    expect(parseSettings('{"kiosk":true}')).toEqual({ kiosk: true });
  });

  it("reads a missing file as windowed", () => {
    expect(parseSettings(undefined)).toEqual({ kiosk: false });
    expect(parseSettings(null)).toEqual({ kiosk: false });
  });

  it("reads malformed JSON as windowed", () => {
    for (const raw of ["", "{", '{"kiosk":true', "kiosk=true", "\u0000"]) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: false });
    }
  });

  it("reads a kiosk value that is not a boolean as windowed", () => {
    for (const raw of ['{"kiosk":"true"}', '{"kiosk":"false"}', '{"kiosk":1}', '{"kiosk":0}', '{"kiosk":null}', "{}"]) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: false });
    }
  });

  it("reads a document that is not an object as windowed", () => {
    for (const raw of ["true", "1", "null", '"kiosk"', "[true]", '[{"kiosk":true}]']) {
      expect(parseSettings(raw), raw).toEqual({ kiosk: false });
    }
  });

  it("reads anything that is not file text as windowed", () => {
    for (const raw of [{ kiosk: true }, true, 1, []]) {
      expect(parseSettings(raw)).toEqual({ kiosk: false });
    }
  });

  it("the dev override wins over the saved setting, which wins over windowed", () => {
    expect(kioskAtLaunch({ windowedOverride: true, saved: { kiosk: true } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: true, saved: { kiosk: false } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: false, saved: { kiosk: false } })).toBe(false);
    expect(kioskAtLaunch({ windowedOverride: false, saved: { kiosk: true } })).toBe(true);
    expect(kioskAtLaunch({ windowedOverride: false, saved: parseSettings(undefined) })).toBe(false);
  });
});
