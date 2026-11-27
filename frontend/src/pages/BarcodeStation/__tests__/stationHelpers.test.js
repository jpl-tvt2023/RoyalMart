import {
  describe, test, expect, beforeAll, afterAll, vi,
} from 'vitest';
import {
  isIOS, visibleCrop, preferredBackCamera, cameraErrorMessage,
} from '../stationHelpers';

// The camera scanner's pure helpers. The camera itself cannot run in jsdom, so
// what decides WHICH part of a frame is decoded, WHICH lens an iPhone uses and
// WHAT the person is told lives here, where it can be pinned.

const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

describe('isIOS', () => {
  test('an iPhone browser is iOS, whichever app it is', () => {
    expect(isIOS({ userAgent: IPHONE_CHROME, platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
  });

  test('an iPad that reports itself as a Mac is iOS', () => {
    expect(isIOS({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  });

  test('a real Mac and an Android phone are not', () => {
    expect(isIOS({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIOS({ userAgent: ANDROID_CHROME, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false);
  });

  test('no navigator is not iOS', () => {
    expect(isIOS(null)).toBe(false);
  });
});

describe('visibleCrop', () => {
  test('a landscape frame in a wider box loses its top and bottom', () => {
    // 1920x1080 frame in a 400x150 box: scale = 400/1920, so 1920x720 shows.
    expect(visibleCrop(1920, 1080, 400, 150)).toEqual({ sx: 0, sy: 180, sw: 1920, sh: 720 });
  });

  test('a portrait frame (iPhone held upright) in a wide box keeps a middle band', () => {
    // 1080x1920 frame in a 360x256 box: scale = 1/3, so 1080x768 shows.
    expect(visibleCrop(1080, 1920, 360, 256)).toEqual({ sx: 0, sy: 576, sw: 1080, sh: 768 });
  });

  test('a frame narrower than the box loses its sides', () => {
    // 1280x720 frame in a 200x200 box: scale = 200/720, so 720x720 shows.
    expect(visibleCrop(1280, 720, 200, 200)).toEqual({ sx: 280, sy: 0, sw: 720, sh: 720 });
  });

  test('a box with no size yet decodes the whole frame', () => {
    expect(visibleCrop(1280, 720, 0, 0)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  test('the crop never leaves the frame', () => {
    for (const [vw, vh, bw, bh] of [[1920, 1080, 333, 257], [1080, 1920, 391, 320], [640, 480, 641, 479]]) {
      const c = visibleCrop(vw, vh, bw, bh);
      expect(c.sx).toBeGreaterThanOrEqual(0);
      expect(c.sy).toBeGreaterThanOrEqual(0);
      expect(c.sx + c.sw).toBeLessThanOrEqual(vw);
      expect(c.sy + c.sh).toBeLessThanOrEqual(vh);
    }
  });
});

describe('preferredBackCamera', () => {
  const cam = (deviceId, label, kind = 'videoinput') => ({ deviceId, label, kind });
  const PRO = [
    cam('f', 'Front Camera'),
    cam('b', 'Back Camera'),
    cam('u', 'Back Ultra Wide Camera'),
    cam('dw', 'Back Dual Wide Camera'),
    cam('t', 'Back Triple Camera'),
    cam('m', 'iPhone Microphone', 'audioinput'),
  ];

  test('a Pro iPhone gets the Triple Camera', () => {
    expect(preferredBackCamera(PRO)).toBe('t');
  });

  test('a two-lens iPhone gets the Dual Wide Camera', () => {
    expect(preferredBackCamera(PRO.filter((d) => d.deviceId !== 't'))).toBe('dw');
  });

  test('a phone with one back lens, or no labels yet, keeps its camera', () => {
    expect(preferredBackCamera([cam('f', 'Front Camera'), cam('b', 'Back Camera')])).toBeNull();
    expect(preferredBackCamera([cam('x', ''), cam('y', '')])).toBeNull();
    expect(preferredBackCamera(undefined)).toBeNull();
  });

  test('an audio device with a matching label is never picked', () => {
    expect(preferredBackCamera([cam('a', 'Back Triple Camera', 'audioinput')])).toBeNull();
  });
});

describe('cameraErrorMessage', () => {
  const err = (name) => Object.assign(new Error(name), { name });

  // jsdom is not a secure context; a phone on the https link is.
  beforeAll(() => { vi.stubGlobal('isSecureContext', true); });
  afterAll(() => { vi.unstubAllGlobals(); });

  test('blocked camera: an iPhone is sent to the iOS Settings, others to the browser', () => {
    expect(cameraErrorMessage(err('NotAllowedError'), true)).toMatch(/Settings → Chrome \(or Safari\) → Camera/);
    expect(cameraErrorMessage(err('NotAllowedError'), false)).toMatch(/in your browser settings/);
  });

  test('a reader that would not load says so, and offers the gun', () => {
    expect(cameraErrorMessage(err('ReaderLoadError'), true)).toMatch(/barcode reader could not load.*scanner gun/);
  });

  test('anything else falls back to a generic message', () => {
    expect(cameraErrorMessage(err('NotFoundError'), true)).toBe('No camera was found on this device.');
    expect(cameraErrorMessage(err('Whatever'), false)).toBe('The camera could not be started on this browser.');
  });
});
