/**
 * The headset's own cameras, the way Quest Browser gives them to websites:
 * through the ordinary camera API (getUserMedia), once the site has the
 * "Headset cameras" permission. Check my work takes its photo from here
 * when the WebXR camera image isn't available (Quest Browser doesn't grant
 * that one).
 *
 * The permission is asked for on the page, before entering mixed reality
 * (asking from inside the headset view would drop out of it). Once granted,
 * the camera is started when a session begins and stopped when it ends.
 */

export type CameraStatus = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

/** Longest side of the stream asked for (the photo is scaled down anyway). */
const IDEAL_WIDTH = 1280;
const IDEAL_HEIGHT = 960;

export const headsetCamera = {
  status: 'unknown' as CameraStatus,
  /** Bumps when the status changes (the page re-renders on it). */
  version: 0,
  stream: null as MediaStream | null,
  video: null as HTMLVideoElement | null,
  /** The camera chosen (a "facing back" one: the headset's outward cameras). */
  label: '',
};

function setStatus(status: CameraStatus) {
  if (headsetCamera.status === status) return;
  headsetCamera.status = status;
  headsetCamera.version++;
}

const supported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Whether the site may already use the camera (no prompt needed), without asking. */
export async function checkCameraPermission(): Promise<CameraStatus> {
  if (!supported()) {
    setStatus('unsupported');
    return headsetCamera.status;
  }
  try {
    const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
    setStatus(result.state === 'granted' ? 'granted' : result.state === 'denied' ? 'denied' : 'prompt');
    result.onchange = () => setStatus(result.state === 'granted' ? 'granted' : result.state === 'denied' ? 'denied' : 'prompt');
  } catch {
    // Permissions API without "camera": we'll know when we ask.
    setStatus('prompt');
  }
  return headsetCamera.status;
}

/**
 * Starts the headset camera (asking for permission if needed: call from a tap
 * on the page). Picks one of the outward "facing back" cameras when the
 * browser lists them. Returns whether it's running.
 */
export async function startHeadsetCamera(): Promise<boolean> {
  if (headsetCamera.stream) return true;
  if (!supported()) {
    setStatus('unsupported');
    return false;
  }
  try {
    let stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: IDEAL_WIDTH }, height: { ideal: IDEAL_HEIGHT } },
      audio: false,
    });
    // With permission the cameras' names are visible: prefer an outward ("facing back") one.
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    const outward = cameras.find((d) => /facing back|back|environment/i.test(d.label));
    if (outward && outward.deviceId && outward.deviceId !== current) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: outward.deviceId }, width: { ideal: IDEAL_WIDTH }, height: { ideal: IDEAL_HEIGHT } },
        audio: false,
      });
    }
    headsetCamera.label = stream.getVideoTracks()[0]?.label ?? '';
    headsetCamera.stream = stream;
    headsetCamera.video = await playHidden(stream);
    setStatus('granted');
    return true;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unsupported' : 'prompt');
    console.warn('Headset camera not started', err);
    return false;
  }
}

/** Starts it only if that needs no prompt (permission already granted): for a session starting. */
export async function startHeadsetCameraIfAllowed(): Promise<boolean> {
  // Granted earlier on this page (Allow camera), or remembered by the browser.
  if (headsetCamera.status !== 'granted' && (await checkCameraPermission()) !== 'granted') return false;
  return startHeadsetCamera();
}

/** Stops the camera (the session ended): the headset's camera light goes off. */
export function stopHeadsetCamera() {
  headsetCamera.stream?.getTracks().forEach((t) => t.stop());
  headsetCamera.stream = null;
  if (headsetCamera.video) {
    headsetCamera.video.srcObject = null;
    headsetCamera.video.remove();
    headsetCamera.video = null;
  }
}

/** A photo from the running camera, longest side at most `maxSize`, as a JPEG data URL; null if it isn't running. */
export function captureHeadsetCamera(maxSize: number): string | null {
  const video = headsetCamera.video;
  if (!video || !headsetCamera.stream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
  const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** A playing, invisible video of the stream (kept in the page so the browser keeps decoding it). */
async function playHidden(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  video.srcObject = stream;
  document.body.appendChild(video);
  try {
    await video.play();
  } catch {
    // autoplay of a muted video is allowed; if not, frames still arrive once it plays
  }
  return video;
}
