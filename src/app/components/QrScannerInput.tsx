'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';

export type QrScannerSource = 'CAMERA' | 'MANUAL_SIMULATED';

export interface QrScannerScanPayload {
  readonly code: string;
  readonly source: QrScannerSource;
}

export interface QrScannerInputProps {
  readonly onScan: (payload: QrScannerScanPayload) => void | Promise<void>;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly label?: string;
  readonly placeholder?: string;
  readonly initialCode?: string;
  readonly enableFeedbackCues?: boolean;
  readonly duplicateFrameCooldownMs?: number;
  readonly loadZxingBrowser?: () => Promise<typeof import('@zxing/browser')>;
}

type CameraStatus = 'IDLE' | 'STARTING' | 'ACTIVE' | 'ERROR';

const CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/;
const DEFAULT_DUPLICATE_COOLDOWN_MS = 1500;

function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore track cleanup errors during teardown
    }
  }
}

function triggerFeedbackCue(
  kind: 'SUCCESS' | 'ERROR',
  enabled: boolean,
): void {
  if (!enabled || typeof window === 'undefined') {
    return;
  }
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    ) {
      navigator.vibrate(kind === 'SUCCESS' ? 40 : [60, 40, 60]);
    }
  } catch {
    // Ignore unsupported vibration errors
  }

  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (typeof AudioCtx === 'function') {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = kind === 'SUCCESS' ? 880 : 240;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (kind === 'SUCCESS' ? 0.08 : 0.16));
    }
  } catch {
    // Ignore audio context restrictions in headless/autoplay-locked contexts
  }
}

function normalizeManualCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || CONTROL_CHARS_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed.toUpperCase();
}

/**
 * Gloved-friendly, WCAG 2.2 AA accessible QR/Barcode scanner (`NFR-ACC-01`) wrapping
 * `@zxing/browser` with a deterministic manual/simulated fallback form
 * (`data-testid="simulated-barcode-input"` and `data-testid="simulated-barcode-submit"`).
 */
export function QrScannerInput({
  onScan,
  disabled = false,
  busy = false,
  label = 'Scan QR or Enter Barcode',
  placeholder = 'PRT-884920 or KEMP-C01-R01-S01-B01',
  initialCode = '',
  enableFeedbackCues = true,
  duplicateFrameCooldownMs = DEFAULT_DUPLICATE_COOLDOWN_MS,
  loadZxingBrowser,
}: QrScannerInputProps): React.ReactElement {
  const inputId = useId();
  const statusId = useId();

  const [manualValue, setManualValue] = useState(initialCode);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('IDLE');
  const [statusMessage, setStatusMessage] = useState(
    'Ready. Enter a barcode or start the camera scanner.',
  );
  const [statusTone, setStatusTone] = useState<'NEUTRAL' | 'SUCCESS' | 'ERROR'>(
    'NEUTRAL',
  );
  const [focusedControl, setFocusedControl] = useState<
    'CAMERA_BTN' | 'INPUT' | 'SUBMIT_BTN' | null
  >(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraSessionRef = useRef(0);
  const isMountedRef = useRef(true);
  const isSubmittingRef = useRef(false);
  const busyOrDisabledRef = useRef(disabled || busy);
  const lastCameraScanRef = useRef<{ code: string; atMs: number } | null>(null);

  busyOrDisabledRef.current = disabled || busy;

  const stopCameraInternal = useCallback((nextMessage?: string) => {
    cameraSessionRef.current += 1;

    const controls = controlsRef.current;
    controlsRef.current = null;
    if (controls) {
      try {
        controls.stop();
      } catch {
        // Ignore stop errors
      }
    }

    const stream = streamRef.current;
    streamRef.current = null;
    stopMediaStream(stream);

    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {
        // Ignore video detach errors in non-browser DOMs
      }
    }

    if (isMountedRef.current) {
      setCameraStatus('IDLE');
      if (nextMessage) {
        setStatusTone('NEUTRAL');
        setStatusMessage(nextMessage);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopCameraInternal();
    };
  }, [stopCameraInternal]);

  const dispatchScan = useCallback(
    async (code: string, source: QrScannerSource): Promise<void> => {
      if (busyOrDisabledRef.current || isSubmittingRef.current) {
        return;
      }

      isSubmittingRef.current = true;
      if (isMountedRef.current) {
        setIsSubmitting(true);
        setStatusTone('NEUTRAL');
        setStatusMessage(`Processing scan ${code}...`);
      }

      try {
        await onScan({ code, source });
        triggerFeedbackCue('SUCCESS', enableFeedbackCues);
        if (isMountedRef.current) {
          setStatusTone('SUCCESS');
          setStatusMessage(`Scanned ${code}.`);
          if (source === 'MANUAL_SIMULATED') {
            setManualValue('');
          }
        }
      } catch (err) {
        triggerFeedbackCue('ERROR', enableFeedbackCues);
        if (isMountedRef.current) {
          const message =
            err instanceof Error && err.message.trim().length > 0
              ? err.message
              : `Scan failed for ${code}.`;
          setStatusTone('ERROR');
          setStatusMessage(message);
        }
      } finally {
        isSubmittingRef.current = false;
        if (isMountedRef.current) {
          setIsSubmitting(false);
        }
      }
    },
    [enableFeedbackCues, onScan],
  );

  const handleManualSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (disabled || busy || isSubmittingRef.current) {
        return;
      }

      const normalized = normalizeManualCode(manualValue);
      if (!normalized) {
        triggerFeedbackCue('ERROR', enableFeedbackCues);
        setStatusTone('ERROR');
        setStatusMessage(
          'Enter a valid non-empty barcode without control characters.',
        );
        return;
      }

      await dispatchScan(normalized, 'MANUAL_SIMULATED');
    },
    [busy, disabled, dispatchScan, enableFeedbackCues, manualValue],
  );

  const handleStartCamera = useCallback(async () => {
    if (disabled || busy) {
      return;
    }

    // Stop any previous stream before starting a fresh session
    stopCameraInternal();
    const sessionId = ++cameraSessionRef.current;

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCameraStatus('ERROR');
      setStatusTone('ERROR');
      setStatusMessage(
        'Camera hardware is unavailable in this browser. Use the manual barcode field below.',
      );
      return;
    }

    setCameraStatus('STARTING');
    setStatusTone('NEUTRAL');
    setStatusMessage('Starting camera scanner...');

    let localStream: MediaStream | null = null;
    try {
      const zxingModule = loadZxingBrowser
        ? await loadZxingBrowser()
        : await import('@zxing/browser');

      if (!isMountedRef.current || cameraSessionRef.current !== sessionId) {
        return;
      }

      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });

      if (!isMountedRef.current || cameraSessionRef.current !== sessionId) {
        stopMediaStream(localStream);
        return;
      }

      const reader = new zxingModule.BrowserMultiFormatReader();
      const videoElem = videoRef.current ?? undefined;
      const controls = await reader.decodeFromStream(
        localStream,
        videoElem,
        (result) => {
          if (!isMountedRef.current || cameraSessionRef.current !== sessionId) {
            return;
          }
          if (!result || busyOrDisabledRef.current || isSubmittingRef.current) {
            return;
          }
          const text = normalizeManualCode(result.getText());
          if (!text) {
            return;
          }
          const nowMs = Date.now();
          const last = lastCameraScanRef.current;
          if (
            last &&
            last.code === text &&
            nowMs - last.atMs < duplicateFrameCooldownMs
          ) {
            return;
          }
          lastCameraScanRef.current = { code: text, atMs: nowMs };
          void dispatchScan(text, 'CAMERA');
        },
      );

      if (!isMountedRef.current || cameraSessionRef.current !== sessionId) {
        try {
          controls.stop();
        } catch {
          // Ignore cleanup errors on stale start
        }
        stopMediaStream(localStream);
        return;
      }

      streamRef.current = localStream;
      controlsRef.current = controls;
      setCameraStatus('ACTIVE');
      setStatusTone('NEUTRAL');
      setStatusMessage(
        'Camera active. Point at QR tag or use manual barcode entry.',
      );
    } catch (err) {
      stopMediaStream(localStream);
      if (!isMountedRef.current || cameraSessionRef.current !== sessionId) {
        return;
      }
      const message =
        err instanceof Error && err.message.trim().length > 0
          ? `Camera unavailable (${err.message}). Manual barcode input remains active.`
          : 'Camera permission denied or unavailable. Manual barcode input remains active.';
      setCameraStatus('ERROR');
      setStatusTone('ERROR');
      setStatusMessage(message);
    }
  }, [
    busy,
    disabled,
    dispatchScan,
    duplicateFrameCooldownMs,
    loadZxingBrowser,
    stopCameraInternal,
  ]);

  const effectiveDisabled = disabled || busy || isSubmitting;
  const isCameraRunning =
    cameraStatus === 'STARTING' || cameraStatus === 'ACTIVE';

  const statusStyles =
    statusTone === 'ERROR'
      ? {
          backgroundColor: '#FEF2F2',
          borderColor: '#991B1B',
          color: '#991B1B',
        }
      : statusTone === 'SUCCESS'
        ? {
            backgroundColor: '#F0FDF4',
            borderColor: '#166534',
            color: '#166534',
          }
        : {
            backgroundColor: '#F8FAFC',
            borderColor: '#334155',
            color: '#0F172A',
          };

  return (
    <section
      aria-label="QR and Barcode Scanner"
      data-testid="qr-scanner-input-root"
      style={{
        backgroundColor: '#FFFFFF',
        color: '#0F172A',
        border: '2px solid #0F172A',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}
      >
        <span
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: '#0F172A',
          }}
        >
          {label}
        </span>

        <button
          type="button"
          data-testid="camera-toggle-button"
          disabled={disabled || busy}
          onClick={() => {
            if (isCameraRunning) {
              stopCameraInternal('Camera stopped. Manual barcode input ready.');
            } else {
              void handleStartCamera();
            }
          }}
          onFocus={() => setFocusedControl('CAMERA_BTN')}
          onBlur={() => setFocusedControl(null)}
          style={{
            minHeight: '56px',
            minWidth: '56px',
            padding: '12px 20px',
            fontSize: '16px',
            fontWeight: 700,
            backgroundColor: isCameraRunning ? '#991B1B' : '#0F172A',
            color: '#FFFFFF',
            border: '2px solid #0F172A',
            borderRadius: '8px',
            cursor: disabled || busy ? 'not-allowed' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            opacity: disabled || busy ? 0.65 : 1,
            outline:
              focusedControl === 'CAMERA_BTN' ? '3px solid #2563EB' : 'none',
            outlineOffset: '2px',
          }}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <span>{isCameraRunning ? 'Stop camera' : 'Start camera'}</span>
        </button>
      </div>

      <video
        ref={videoRef}
        data-testid="qr-scanner-video"
        muted
        playsInline
        aria-label="Camera scanner preview"
        style={{
          width: '100%',
          maxHeight: isCameraRunning ? '260px' : '0px',
          display: isCameraRunning ? 'block' : 'none',
          backgroundColor: '#0F172A',
          borderRadius: '8px',
        }}
      />

      <form
        onSubmit={(e) => {
          void handleManualSubmit(e);
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        <label
          htmlFor={inputId}
          style={{
            fontSize: '15px',
            fontWeight: 700,
            color: '#0F172A',
          }}
        >
          Manual / Simulated Barcode
        </label>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
          }}
        >
          <input
            id={inputId}
            type="text"
            data-testid="simulated-barcode-input"
            aria-describedby={statusId}
            value={manualValue}
            placeholder={placeholder}
            disabled={effectiveDisabled}
            autoComplete="off"
            autoCapitalize="characters"
            onChange={(e) => setManualValue(e.target.value)}
            onFocus={() => setFocusedControl('INPUT')}
            onBlur={() => setFocusedControl(null)}
            style={{
              flex: '1 1 220px',
              minHeight: '56px',
              minWidth: '56px',
              padding: '12px 14px',
              fontSize: '16px',
              fontWeight: 600,
              backgroundColor: '#FFFFFF',
              color: '#0F172A',
              border: '2px solid #0F172A',
              borderRadius: '8px',
              outline:
                focusedControl === 'INPUT' ? '3px solid #2563EB' : 'none',
              outlineOffset: '2px',
            }}
          />

          <button
            type="submit"
            data-testid="simulated-barcode-submit"
            disabled={effectiveDisabled}
            onFocus={() => setFocusedControl('SUBMIT_BTN')}
            onBlur={() => setFocusedControl(null)}
            style={{
              minHeight: '56px',
              minWidth: '56px',
              padding: '12px 22px',
              fontSize: '16px',
              fontWeight: 700,
              backgroundColor: '#1E40AF',
              color: '#FFFFFF',
              border: '2px solid #1E3A8A',
              borderRadius: '8px',
              cursor: effectiveDisabled ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              opacity: effectiveDisabled ? 0.65 : 1,
              outline:
                focusedControl === 'SUBMIT_BTN' ? '3px solid #2563EB' : 'none',
              outlineOffset: '2px',
            }}
          >
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{isSubmitting || busy ? 'Processing...' : 'Submit Scan'}</span>
          </button>
        </div>
      </form>

      <div
        id={statusId}
        role="status"
        aria-live="polite"
        data-testid="qr-scanner-status"
        data-status-tone={statusTone}
        style={{
          ...statusStyles,
          borderWidth: '2px',
          borderStyle: 'solid',
          borderRadius: '8px',
          padding: '10px 14px',
          fontSize: '15px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          {statusTone === 'ERROR' ? (
            <>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </>
          ) : statusTone === 'SUCCESS' ? (
            <>
              <circle cx="12" cy="12" r="10" />
              <polyline points="16 9 10.5 14.5 8 12" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </>
          )}
        </svg>
        <span>{statusMessage}</span>
      </div>
    </section>
  );
}
