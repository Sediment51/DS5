import { useCallback, useEffect, useRef, useState } from 'react';
import { resetDemo } from '../lib/demoReset';
import { loadWoundOpacity, saveWoundOpacity } from '../lib/woundOpacity';
import { KitSummary } from '../mat/KitSummary';
import { loadKit, type KitResult } from '../mat/lib/kit';
import type { MatSystem } from '../mat/xr/MatSystem';
import type * as THREE from 'three';
import type { HandStatus } from './Hud';
import { OpacitySlider } from './OpacitySlider';
import { XRScene, type XRMode } from './XRScene';

/** Used to drop the room to the floor when the runtime has no floor-level space. */
const STANDING_EYE_HEIGHT = 1.6;

/**
 * Mixed reality also asks for what the material mat uses to find and stick to
 * the table, the room's light, and the camera image (to match the wound to
 * the palm's real colour), each used only if granted.
 */
const MAT_FEATURES = ['plane-detection', 'anchors', 'hit-test', 'light-estimation', 'camera-access'];

/** Asks for a session, retrying with fewer requirements if the first ask is refused. */
async function requestSession(xr: XRSystem, mode: XRSessionMode): Promise<XRSession> {
  const extras = mode === 'immersive-ar' ? MAT_FEATURES : [];
  try {
    return await xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking', ...extras],
    });
  } catch (err) {
    console.warn('Session with a floor-level space refused, retrying without requirements.', err);
    return xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking', ...extras] });
  }
}

/** How to open the mixed-reality version in Quest Browser, by hand or over USB. */
function QuestBrowserSteps() {
  const url = window.location.href.split('#')[0];
  const shortUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const adb = `adb shell am start -a android.intent.action.VIEW -d "${url}" com.oculus.browser`;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(adb).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <>
      <ol className="xr-steps">
        <li>
          In the headset, open <strong>Browser</strong> and go to <strong>{shortUrl}</strong>
        </li>
        <li>
          Tap <strong>Start mixed reality</strong>, then <strong>Enter mixed reality</strong>.
        </li>
        <li>Put the controllers down and hold up your open palm.</li>
      </ol>
      <details className="xr-details">
        <summary>Open it from this laptop over the USB cable</summary>
        <p>
          With developer mode on and the headset connected by USB, run this on the laptop (needs{' '}
          <strong>adb</strong>, e.g. from Meta Quest Developer Hub) to open the page in the headset:
        </p>
        <code className="xr-code">{adb}</code>
        <button type="button" className="panel button" onClick={copy}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </details>
    </>
  );
}

/** How long "Tap again" waits for the second tap, and how long "Demo reset" shows (ms). */
const RESET_CONFIRM_MS = 4000;
const RESET_DONE_MS = 5000;

/**
 * Reset demo: forgets the saved mat and the settings, so the next time you
 * enter it starts from the very beginning (trace the mat, meet Buddy).
 * Two taps, so it can't happen by accident.
 */
function ResetDemo({ onReset }: { onReset: () => void }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'done'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), state === 'confirm' ? RESET_CONFIRM_MS : RESET_DONE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const press = () => {
    if (state !== 'confirm') {
      setState('confirm');
      return;
    }
    resetDemo();
    onReset();
    setState('done');
  };
  return (
    <div className="xr-reset">
      {state === 'done' ? (
        <p className="xr-reset-done" role="status">
          ✓ Demo reset. Next time you enter, it starts from the beginning.
        </p>
      ) : (
        <>
          <button type="button" className={`panel button${state === 'confirm' ? ' xr-reset-confirm' : ''}`} onClick={press}>
            {state === 'confirm' ? 'Tap again to reset' : 'Reset demo'}
          </button>
          <p className="xr-note">Forgets the saved mat and settings, so the next session starts from the very beginning.</p>
        </>
      )}
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error || err instanceof DOMException) {
    return err.message ? `${err.name}: ${err.message}` : err.name;
  }
  return String(err);
}

interface Support {
  ar: boolean;
  vr: boolean;
}

const STATUS_LABEL: Record<HandStatus, string> = {
  none: 'Looking for your hand…',
  closed: 'Open your hand',
  open: 'Hand detected',
};

interface XRViewProps {
  onExit: () => void;
}

/**
 * Headset mode (e.g. Meta Quest 3 over Quest Link, or the Quest's own
 * browser). The wound is placed with the headset's hand tracking, so no
 * webcam is used. The page stays on the laptop screen as a control panel.
 */
export function XRView({ onExit }: XRViewProps) {
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const [support, setSupport] = useState<Support | null>(null);
  const [mode, setMode] = useState<XRMode | null>(null);
  const [handStatus, setHandStatus] = useState<HandStatus>('none');
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [floorY, setFloorY] = useState(0);
  // Shared with the slider inside the headset; remembered like the webcam view's.
  const [woundOpacity, setWoundOpacity] = useState(loadWoundOpacity);
  const woundOpacityRef = useRef(woundOpacity);
  useEffect(() => {
    woundOpacityRef.current = woundOpacity;
    saveWoundOpacity(woundOpacity);
  }, [woundOpacity]);

  // The material mat's kit, laid out on the table in mixed reality.
  const [kitResult, setKitResult] = useState<KitResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadKit().then((result) => !cancelled && setKitResult(result));
    return () => {
      cancelled = true;
    };
  }, []);
  const matSystemRef = useRef<MatSystem | null>(null);
  const onMatSystem = useCallback((system: MatSystem | null) => {
    matSystemRef.current = system;
  }, []);
  // ?test (for the emulator): T traces a test mat rectangle.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('test')) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'KeyT') matSystemRef.current?.traceTestRectangle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const xr = navigator.xr;
    const check = (m: XRSessionMode) => (xr ? xr.isSessionSupported(m).catch(() => false) : Promise.resolve(false));
    Promise.all([check('immersive-ar'), check('immersive-vr')]).then(([ar, vr]) => {
      if (!cancelled) setSupport({ ar, vr });
    });
    return () => {
      cancelled = true;
      void rendererRef.current?.xr.getSession()?.end().catch(() => {});
    };
  }, []);

  const enter = async (next: XRMode) => {
    const renderer = rendererRef.current;
    const xr = navigator.xr;
    if (!renderer || !xr) return;
    setError(null);

    let session: XRSession | null = null;
    try {
      session = await requestSession(xr, next === 'ar' ? 'immersive-ar' : 'immersive-vr');
    } catch (err) {
      console.error(err);
      setError({ message: 'The headset refused to start the session.', detail: describeError(err) });
      return;
    }

    try {
      // Prefer a floor-level space; without one, the origin is at head height.
      const floorLevel = await session
        .requestReferenceSpace('local-floor')
        .then(() => true)
        .catch(() => false);
      session.addEventListener('end', () => setMode(null));
      renderer.xr.setReferenceSpaceType(floorLevel ? 'local-floor' : 'local');
      setFloorY(floorLevel ? 0 : -STANDING_EYE_HEIGHT);
      setMode(next);
      // Full-resolution eye buffers, light foveation (Quest 3 holds 72+ fps with these).
      renderer.xr.setFramebufferScaleFactor(1.0);
      renderer.xr.setFoveation(0.3);
      await renderer.xr.setSession(session);
    } catch (err) {
      console.error(err);
      setMode(null);
      void session.end().catch(() => {});
      setError({
        message: 'The session started but the page couldn’t draw into the headset.',
        detail: describeError(err),
      });
    }
  };

  const exitSession = () => {
    void rendererRef.current?.xr.getSession()?.end();
  };

  const supported = support && (support.ar || support.vr);

  return (
    <div className="xr-root">
      <div className="xr-canvas">
        <XRScene
          mode={mode}
          floorY={floorY}
          rendererRef={rendererRef}
          onHandStatus={setHandStatus}
          woundOpacity={woundOpacityRef}
          onWoundOpacityChange={setWoundOpacity}
          kit={kitResult?.ok ? kitResult.kit : null}
          onMatSystem={onMatSystem}
        />
      </div>

      <div className="panel xr-card">
        <h1>Meta Quest</h1>

        {mode ? (
          <>
            <p>
              You’re in {mode === 'ar' ? 'mixed reality' : 'VR'}. Put the controllers down and hold up
              your open palm in front of you.
            </p>
            <span className={`pill pill--${handStatus}`} role="status">
              <span className="pill-dot" aria-hidden />
              {STATUS_LABEL[handStatus]}
            </span>
            <OpacitySlider value={woundOpacity} onChange={setWoundOpacity} />
            {mode === 'ar' && kitResult?.ok && (
              <p className="xr-note">
                First, set up your workspace: pinch thumb and index on your table and trace your mat. Buddy
                then introduces itself; tap <strong>Start working</strong> when you’re ready.
              </p>
            )}
            <p className="xr-note">
              In the headset, <strong>☰ Menu</strong> is at the mat’s front-right corner;{' '}
              <strong>Materials</strong> and <strong>Appearance</strong> (opacity and colour) float above its
              back corners. Press them with a fingertip.
            </p>
            <p className="xr-note">
              To move the mat, a panel or Buddy, put your hand on it (or point your hand at it) and make a
              fist: it follows your fist until you open your hand.
            </p>
            <button type="button" className="button button--primary" onClick={exitSession}>
              Exit headset
            </button>
          </>
        ) : support === null ? (
          <p>Checking for a headset…</p>
        ) : supported && !support.ar ? (
          <>
            <p>
              <strong>Mixed reality isn’t available over Quest Link</strong> — PC browsers can only show
              VR through the cable, not your real room. The AR version runs in the Quest’s own browser:
            </p>
            <QuestBrowserSteps />
            <p className="xr-note">Or try it in VR here, with virtual hands in a simple room:</p>
            <button type="button" className="panel button" onClick={() => enter('vr')}>
              Enter VR
            </button>
          </>
        ) : supported ? (
          <>
            <p>
              Put on your headset, then start. The wound follows your palm using the headset’s own
              hand tracking — no webcam needed.
            </p>
            <OpacitySlider value={woundOpacity} onChange={setWoundOpacity} />
            <div className="xr-actions">
              {support.ar && (
                <button type="button" className="button button--primary" onClick={() => enter('ar')}>
                  Enter mixed reality
                </button>
              )}
              {/* This is an AR experience: VR is only the fallback where passthrough isn't possible. */}
              {support.vr && !support.ar && (
                <button type="button" className="button button--primary" onClick={() => enter('vr')}>
                  Enter VR
                </button>
              )}
            </div>
            <ResetDemo onReset={() => setWoundOpacity(1)} />
          </>
        ) : (
          <>
            <p>
              No headset found here. For mixed reality — your real room, with the wound on your real
              palm — open this page in the Quest’s own browser:
            </p>
            <QuestBrowserSteps />
          </>
        )}

        {error && (
          <div className="xr-error" role="alert">
            <p className="intro-error">
              {error.message}
              <span className="xr-error-detail">{error.detail}</span>
            </p>
            <p>Things to check, then press Enter VR again:</p>
            <ol className="xr-steps">
              <li>
                The headset is <strong>inside Quest Link</strong> (you see the Link home screen in it),
                not just plugged in.
              </li>
              <li>
                Laptops with two graphics chips: Windows Settings → System → Display → Graphics → add
                Chrome/Edge and choose <strong>High performance</strong>, then restart the browser.
              </li>
              <li>
                In the Meta Quest Link app, Settings → General → OpenXR runtime is set to
                <strong> Meta Quest Link</strong>, and SteamVR or other VR apps are closed.
              </li>
              <li>
                Still stuck? Open <strong>{window.location.href}</strong> in the Quest’s own browser —
                no cable needed.
              </li>
            </ol>
          </div>
        )}

        {support?.ar && <KitSummary result={kitResult} />}

        <details className="xr-details">
          <summary>Mentor feedback (“Check my work”)</summary>
          <p>
            Buddy can look at your hand through the headset camera and give feedback on the current step. It
            works on the app’s Vercel link (with <code>GEMINI_API_KEY</code> set in the Vercel project), or
            from this laptop: <code>GEMINI_API_KEY=…</code> in <code>.env.local</code>, the Quest on USB with{' '}
            <code>adb reverse tcp:5173 tcp:5173</code>, and <strong>localhost:5173</strong> in Quest Browser.
            It doesn’t work on the GitHub Pages link. Photos are sent to the AI service only when you press the
            button.
          </p>
        </details>

        {!mode && (
          <button type="button" className="button button--quiet xr-back" onClick={onExit}>
            Back
          </button>
        )}
      </div>
    </div>
  );
}
