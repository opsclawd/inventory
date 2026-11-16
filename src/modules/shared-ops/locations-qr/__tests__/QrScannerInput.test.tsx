// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrScannerInput } from '@/app/components/QrScannerInput';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbStringToTuple(rgb: string): [number, number, number] {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb);
  if (match) {
    return [
      Number.parseInt(match[1]!, 10),
      Number.parseInt(match[2]!, 10),
      Number.parseInt(match[3]!, 10),
    ];
  }
  return hexToRgb(rgb);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(rgbStringToTuple(fg));
  const l2 = relativeLuminance(rgbStringToTuple(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function createFakeStream() {
  const track = {
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe('Issue #6: QrScannerInput (Simulated Fallback, Camera Lifecycle & NFR-ACC-01)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('always renders deterministic fallback controls, handles click and Enter once, and rejects blank input', async () => {
    const user = userEvent.setup();
    const onScan = vi.fn();

    render(<QrScannerInput onScan={onScan} enableFeedbackCues={false} />);

    const input = screen.getByTestId(
      'simulated-barcode-input',
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      'simulated-barcode-submit',
    ) as HTMLButtonElement;

    // Empty submit shows accessible error without invoking onScan
    await user.click(submit);
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('qr-scanner-status').getAttribute('data-status-tone')).toBe('ERROR');

    // Type lowercase barcode and click submit -> normalizes uppercase and clears input
    await user.type(input, '  prt-884920  ');
    await user.click(submit);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenLastCalledWith({
      code: 'PRT-884920',
      source: 'MANUAL_SIMULATED',
    });
    expect(input.value).toBe('');

    // Enter key triggers the same form submit path once
    await user.type(input, 'KEMP-C01-R01-S01-B01{enter}');
    expect(onScan).toHaveBeenCalledTimes(2);
    expect(onScan).toHaveBeenLastCalledWith({
      code: 'KEMP-C01-R01-S01-B01',
      source: 'MANUAL_SIMULATED',
    });
  });

  it('disables submissions while async onScan is pending and recovers cleanly on rejection', async () => {
    const user = userEvent.setup();
    let rejectPending!: (err: Error) => void;
    const onScan = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );

    render(<QrScannerInput onScan={onScan} enableFeedbackCues={false} />);

    const input = screen.getByTestId(
      'simulated-barcode-input',
    ) as HTMLInputElement;
    const submit = screen.getByTestId(
      'simulated-barcode-submit',
    ) as HTMLButtonElement;

    await user.type(input, 'PRT-884920');
    await user.click(submit);

    expect(submit.disabled).toBe(true);
    expect(input.disabled).toBe(true);

    await act(async () => {
      rejectPending(new Error('422 SITE_ZONING_VIOLATION'));
    });

    await waitFor(() => {
      expect(submit.disabled).toBe(false);
    });
    expect(screen.getByTestId('qr-scanner-status').textContent).toContain(
      '422 SITE_ZONING_VIOLATION',
    );
    expect(screen.getByTestId('qr-scanner-status').getAttribute('data-status-tone')).toBe('ERROR');
  });

  it('does not request camera on mount; starts on click, suppresses repeat frames, handles permission denial, and cleans up on stop/unmount', async () => {
    const user = userEvent.setup();
    const { stream, track } = createFakeStream();
    const getUserMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    let decodeCallback!: (result: { getText(): string } | undefined) => void;
    const controlsStop = vi.fn();
    const decodeFromStream = vi.fn(
      async (
        _s: MediaStream,
        _v: HTMLVideoElement | undefined,
        cb: (result: { getText(): string } | undefined) => void,
      ) => {
        decodeCallback = cb;
        return { stop: controlsStop };
      },
    );
    const loadZxingBrowser = vi.fn(async () => ({
      BrowserMultiFormatReader: class {
        public decodeFromStream = decodeFromStream;
      },
    })) as unknown as () => Promise<typeof import('@zxing/browser')>;

    const onScan = vi.fn();
    const { unmount } = render(
      <QrScannerInput
        onScan={onScan}
        enableFeedbackCues={false}
        duplicateFrameCooldownMs={1000}
        loadZxingBrowser={loadZxingBrowser}
      />,
    );

    // Never auto-requests camera on mount
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(loadZxingBrowser).not.toHaveBeenCalled();

    const camBtn = screen.getByTestId('camera-toggle-button');
    await user.click(camBtn);

    await waitFor(() => {
      expect(decodeFromStream).toHaveBeenCalledTimes(1);
    });

    // Duplicate frame within cooldown suppressed
    await act(async () => {
      decodeCallback({ getText: () => 'AST-2026-0001' });
      decodeCallback({ getText: () => 'AST-2026-0001' });
    });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenLastCalledWith({
      code: 'AST-2026-0001',
      source: 'CAMERA',
    });

    // Stop camera cleans up controls and media track
    await user.click(camBtn);
    expect(controlsStop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);

    // Late async camera init completing after unmount stops tracks/controls immediately
    let resolveLateMedia!: (s: MediaStream) => void;
    const lateStream = createFakeStream();
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveLateMedia = resolve;
        }),
    );

    await user.click(camBtn);
    unmount();
    await act(async () => {
      resolveLateMedia(lateStream.stream);
    });
    expect(lateStream.track.stop).toHaveBeenCalledTimes(1);

    // Permission denial keeps fallback form usable
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
    render(
      <QrScannerInput
        onScan={onScan}
        enableFeedbackCues={false}
        loadZxingBrowser={loadZxingBrowser}
      />,
    );
    await user.click(screen.getByTestId('camera-toggle-button'));
    await waitFor(() => {
      expect(screen.getByTestId('qr-scanner-status').getAttribute('data-status-tone')).toBe('ERROR');
    });
    await user.type(screen.getByTestId('simulated-barcode-input'), 'PRT-884921');
    await user.click(screen.getByTestId('simulated-barcode-submit'));
    expect(onScan).toHaveBeenLastCalledWith({
      code: 'PRT-884921',
      source: 'MANUAL_SIMULATED',
    });
  });

  it('meets gloved-friendly >=56px touch targets, >4.5:1 WCAG AA contrast, focus outlines, and aria-live status', () => {
    render(<QrScannerInput onScan={() => {}} enableFeedbackCues={false} />);

    const input = screen.getByTestId('simulated-barcode-input');
    const submit = screen.getByTestId('simulated-barcode-submit');
    const cameraBtn = screen.getByTestId('camera-toggle-button');
    const status = screen.getByTestId('qr-scanner-status');

    for (const el of [input, submit, cameraBtn]) {
      expect(el.style.minHeight).toBe('56px');
      expect(el.style.minWidth).toBe('56px');
    }

    expect(
      contrastRatio(submit.style.color, submit.style.backgroundColor),
    ).toBeGreaterThan(4.5);
    expect(
      contrastRatio(cameraBtn.style.color, cameraBtn.style.backgroundColor),
    ).toBeGreaterThan(4.5);
    expect(
      contrastRatio(input.style.color, input.style.backgroundColor),
    ).toBeGreaterThan(4.5);

    fireEvent.focus(submit);
    expect(submit.style.outline).toContain('3px solid');

    expect(status.getAttribute('aria-live')).toBe('polite');
  });
});
