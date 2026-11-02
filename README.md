# Palm injury — AR hand-tracking prototype

A single-page React + TypeScript app that uses your webcam, tracks your hand in
real time with MediaPipe's **HandLandmarker**, and renders a realistic wound
on your palm (three.js via **@react-three/fiber**) that stays glued to it as
the hand moves, tilts and turns: a sculpted 3D laceration
(`public/models/Wound.glb`) with swollen lips, a deep wet cut and bruising
around it, bent onto the curve of your palm.

## Run it

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL in Chrome, Edge, Firefox or
Safari and click **Start camera**. Camera access needs a secure context
(HTTPS or `localhost`). The hand model (~7.8 MB) and the MediaPipe WASM files
load from Google Storage and jsDelivr on first start, so you need internet
access.

Other scripts: `npm run build` (typecheck + production build into `dist/`),
`npm run preview`, `npm run typecheck`, `npm test` (unit tests, vitest).

### Testing without a camera

Add `?video=<path>` to the URL to play a looping video file instead of the
webcam (same-origin files only, since the frames must be readable). A sample
clip of an open palm moving is bundled: open
`/?video=samples/palm-moving.webm`, or click **No camera? Try the sample
video** on the start screen. See `public/samples/README.md` for its source
and licence.

A second clip, `?video=samples/palm-still.webm`, holds the hand perfectly
still under fresh sensor noise, for measuring jitter.

**Debug** in the HUD shows the frame-sync readout (the latest camera frame,
the frames the wound pose and the background were drawn from, and a count of
renders where they differed) and four overlays you can switch separately:

- **Landmarks**: MediaPipe's 21 points.
- **Palm surface**: the curved surface the wound is bent onto, as a wireframe.
- **Wound box**: the wound's bounding box, bent with it.
- **Jitter**: how much the wound's centre moved over the last second
  (RMS, in video pixels, steady drift removed), next to the same figure for
  the unsmoothed pose. Green below 0.5 px. It reads "moving" while the hand
  moves.

The HUD always shows the render FPS and the mean detection time.

### Mesh view

The **Camera | Mesh** switch in the HUD works like the map / satellite switch
in a maps app. **Camera** is the real picture. **Mesh** hides the camera image
behind a plain light backdrop and redraws your tracked hand as a grayscale 3D
mesh (flat-shaded faces with the wireframe on top), with the wound on its
palm. The mesh is posed live from the same 21 landmarks as the wound, so it
follows your hand. It is a generic hand model fitted to your hand's joints
and size, not a scan of your hand, so it won't show your exact skin, creases
or finger thickness.

## Meta Quest 3 (mixed reality)

The AR experience (your real room through passthrough, with the wound on
your real palm, behaving like the webcam version) runs in the **Quest's own
browser**, using the headset's hand tracking:

1. In the headset, open **Browser** and go to
   `hanumantk.github.io/new-project`.
2. Tap **Start mixed reality**, then **Enter mixed reality**.
3. Put the controllers down and hold up your open palm.

To open it from the laptop over the USB cable instead of typing the address,
enable developer mode on the Quest and run (needs `adb`, e.g. from Meta Quest
Developer Hub):

```bash
adb shell am start -a android.intent.action.VIEW -d "https://hanumantk.github.io/new-project/" com.oculus.browser
```

This is an AR experience: where mixed reality is available, it's the only
option. **Quest Link (PC browser over the cable)** only supports VR, not
passthrough. The page says so, and offers a VR fallback with skin-toned
virtual hands in a simple room (without the material mat).

### The workspace, step by step

Mixed reality introduces things one at a time (`src/lib/workspaceFlow.ts`),
so a first visit is never everything at once:

1. **Set up your workspace.** Only one cue shows ("Set up your workspace":
   pinch on the table below eye level and trace your mat). While you trace, a
   ghost of the mat shows its size: amber ("Keep going") until it's big
   enough, blue ("Let go to place") once it is. When it's placed, its edge
   pulses, a chime plays and "Mat placed" shows above it. A mat from last
   time is restored instead, when the headset finds it.
2. **Meet Buddy.** Buddy flies into the middle of your view, introduces
   itself, then moves to its spot on the left of the mat (or tap **Got it**).
3. **Browse.** The mat with your materials, Buddy on the left, and the menus
   around the mat (below). No hand, no wound. Touch an item's cell with a
   straight index finger to select it: its outline turns solid and its
   purpose shows (and its hologram, if it has one). Touch it again to let go.
4. **Work.** Tap **Start working** (under Buddy). "Tracking on" shows over
   your hand, a wireframe sweeps over it to show it's lined up, and the
   wound appears on your palm. Pinch near it with the other hand to step
   through how it's made: the materials each step uses light up on the mat
   with holograms of how much to take, and each step done flashes cyan round
   the wound. If the headset loses your hand, an amber outline pulses where
   it was ("Left hand lost"). **Pause** goes back to browsing.

Without a mat (the VR fallback) it starts at step 2, around a fixed spot in
front of you.

### Menus

All menus sit around the mat, clear of the middle where you work, and use
one blue style and one set of states (hover: blue outline; on: blue; open: ▾;
working on it: …; done: ✓; unavailable: ⚠ and greyed). Press with a
fingertip. Every panel, the mat and Buddy can be carried with a fist (it
lights up blue while held). Until you move a panel or Buddy it travels with
the mat; once you've put it somewhere it stays exactly there, so moving one
thing never moves another.

- **☰ Menu** (the mat's front-right corner) opens the main menu: material
  labels, Buddy and hand-mesh toggles, wound hand (Left / Right), wound
  height (− / +), **Calibrate** (while working), **Redraw mat** (tap twice)
  and **Reset all** (settings, panel places, Buddy's spot).
- **Materials** (above the back-left corner): ‹ Prev / **Step by step** /
  Next ›, with what's shown ("Step 3 of 9 · Scar wax").
- **Appearance** (above the back-right corner) opens two titled panels:
  - **Opacity**: what it changes (Wound or Mat), its value, a slider, − / +
    and Reset. To slide, **point your index finger** (the other fingers
    curled) and slide along it. A hand just passing by changes nothing, and
    the panel says "Point with just your index finger" if you touch it
    without pointing. While sliding, a bubble shows the value; letting go
    shows "✓ Set to 64%". The headset page has the same wound slider (live
    over Quest Link).
  - **Colour**: skin tone (**Auto** from the headset camera, six presets, a
    fine Tone slider) and the mat's outline colour (Blue, White, Amber), with
    Reset.
- An open menu closes after 12 s untouched; opening one closes the other.
- **Turn the palm without the wound up** and hold it for half a second to
  hide or show all the menus.
- **Cues, not pages:** feedback is shown on the objects themselves (outlines,
  holograms, highlights). When words help, a cue of a few glowing words
  with an icon (no card) appears above what it's about (the mat or your
  hand), or just below your view: cyan ✓ done, amber ! needs attention, blue
  i information.

### Mentor feedback ("Check my work")

While working, **Check my work** (under Buddy) takes a photo through the
headset camera, and the feedback appears on the wound itself: while it's
checking, a blue sweep goes round the wound; then an outline in five parts
(both ends, both long edges, the middle) turns cyan where the work is fine
and pulses amber where it needs refining, with a tip of a few words above
your hand ("Blend the wrist end smoother"). Buddy just reacts. The photo goes to the
app's own dev server (`/api/mentor`), which asks the AI service; the API key
stays on the laptop.

- **Google Gemini** (used when `GEMINI_API_KEY` is set): `gemini-3.8-flash`
  by default; set `GEMINI_MODEL` to use another. When a model is overloaded
  ("high demand", HTTP 503), it asks `gemini-3.6-flash`, then
  `gemini-3.5-flash-lite`. Get a key at https://aistudio.google.com/apikey.
- **Anthropic Claude** (used when only `ANTHROPIC_API_KEY` is set):
  `claude-opus-5-5`, low effort, with server-side fallback.

1. Put your key in `.env.local` next to `package.json` (git ignores it):
   `GEMINI_API_KEY=…`. When you start `npm run dev`, it prints which service
   mentor feedback is using.
2. `npm run dev` on the laptop.
3. Connect the Quest by USB and run `adb reverse tcp:5173 tcp:5173`.
4. In Quest Browser open `http://localhost:5173` (localhost counts as secure
   for WebXR), then **Start mixed reality** and allow camera access.

It needs the browser to grant WebXR camera access (the same one Auto skin
tone uses). Without it, or without the key or a server (e.g. on GitHub
Pages, which only serves files), the button explains why instead. Code:
`src/lib/mentorAnalysis.ts` (client), `src/server/` (endpoint and prompt),
`api/mentor.ts` (the same endpoint as a Vercel function).

#### Hosting it with feedback: Vercel

Vercel hosts the app and runs `/api/mentor` next to it, so one link works in
the Quest with feedback and no laptop:

1. On vercel.com, sign up with GitHub and **Add New → Project →** import this
   repository. The settings come from `vercel.json` (Vite, `npm run build`,
   `dist`); keep them.
2. **Settings → Environment Variables:** add `GEMINI_API_KEY` with your key
   (for Production, and Preview if you like). Never prefix it with `VITE_`:
   anything starting with `VITE_` is copied into the page, where anyone can
   read it.
3. **Deployments → Redeploy** so it picks up the key, then open the project's
   `….vercel.app` link in Quest Browser.

Every push to `main` redeploys. The function gets up to 60 s, enough for the
Gemini fallbacks above.

A detailed sculpted hand model (`public/models/Hand.glb`) is posed on the
headset's hand joints every frame. It was converted from the project
owner's `Hands_ armature.blend`:
- the left hand only (it's mirrored for the right);
- its full sculpt detail (Multires level 3, about 70,000 vertices);
- its 22 deform bones renamed to wrist, metacarpals, phalanges and thumb
  (see `src/lib/xrHandModel.ts`).

To regenerate it, run `scripts/hand-model/export_hand.py`.

The model keeps its own shape and proportions. It's only scaled as a whole to your hand's size (palm
length, measured over about half a second when the hand first appears and
on **Calibrate**). It's mirrored for a right hand.
The wound scales with your palm too: `LENGTH_CM` is its length on an
average hand (`REFERENCE_PALM_CM` from wrist to middle knuckle).
- The wound is laid onto that model's palm skin, smoothed over about 1 cm
  so it follows the palm's curve but not every bump of the model. It's
  skinned with the model's own weights, so it stays fixed to the skin as
  the hand moves, turns and bends.
- An invisible copy of the hand hides the wound behind your real fingers
  and the back of your hand. It's pushed 6 mm back along each line of
  sight, so the skin under the wound never clips it.
- There's no smoothing (the runtime already predicts poses) and no fade
  while the hand is tracked.
- The skin tone comes from the camera when allowed (Auto), otherwise from
  the Colour panel.

### Headset wound: settings and testing

- **Settings:** the wound hand (only that hand is ever used), **Calibrate** (hold your palm flat: it measures your hand for about 0.5 s and lays the wound on afresh; use it for each new user), the **Hand mesh** toggle (the tracked hand model as a wireframe over your real hand, to check how it lines up) and the wound's **height** (±5 mm) are in the ☰ Menu; the skin tone is on the Colour panel. **Auto** (on by default) reads your palm's real colour from the headset camera when the browser grants WebXR camera access: the panel says ✓ when it's working and ⚠ when there's no camera access, so the presets are used. Picking a swatch or moving Tone switches to manual. Settings are saved.
- **Tunable constants** (`src/components/XRWound.tsx`): `LENGTH_CM`, `REFERENCE_PALM_CM`, `ANGLE_DEG`, `OFFSET_MM`, `PALM_OFFSET_MM`, `USE_SKINNING`. The look is `XR_WOUND_LOOK` in `src/lib/xrWoundMaterial.ts`.
- **Emulator:** in Chrome with Meta's Immersive Web Emulator, choose Quest 3, switch input to hand tracking, then open `/?test`, **Start mixed reality → Enter mixed reality**, press **T** to place a test mat, wait for Buddy (or poke **Got it**), poke **Start working**, and pose the left hand with its palm facing you; the wound appears on it.
- **Headset:** open the site in the Quest browser, allow hand tracking, put the controllers down and hold up the chosen palm. Check that the wound stays glued as you move and turn it fast, bends when you cup the palm, and is hidden by curled fingers and when the back of the hand faces you.
- **Lighting:** if the browser grants WebXR light estimation, the room's real light replaces the fixed lights.

## Material mat (in the mixed-reality injury simulation)

Inside the same mixed-reality session as the wound, you can lay out
everything you need for a ~5 cm scar-wax cut on the palm on your real
table. Each material and tool gets a true-to-size outline, its quantity
and its step number. You put the real things on the outlines while the
wound stays on your palm. It's only in mixed reality, not in the VR
fallback.

### In the headset

1. In **Quest Browser**, tap **Start mixed reality**, then **Enter mixed
   reality**, and put the controllers down.
2. **Draw the mat:** pinch thumb and index together on the table and trace
   a rectangle around the area, then let go. A glowing line follows your
   pinch, and a ghost of the mat shows its size as you go. Anything under
   25 × 20 cm is refused with a prompt to redraw.
3. The mat appears on the rectangle, locked to the table (it stays put as
   you walk around). It's laid out like a recipe card: a numbered section
   per group of the workflow (1 Prep, 2 Build, 3 Colour, 4 Finish), from
   the back of the mat to the front, each with its number in a column on
   the left and a line under it. Every material has its own outlined cell:
   its true-size outline, a dashed "compare" spot where the amount matters,
   and a label lying flat on the mat (the amount large, then the name, then
   the steps it's used in). When a material is needed (its step is on, or
   you select it), a blue hologram of how much to take sits on its compare
   spot: put your real wax, jelly or blood in the same spot to compare. On a
   small mat the sections are split into pages.
4. **Controls** (see Menus above): the **Materials** chip turns pages or
   steps through items (step mode highlights one item, shows its purpose
   and dims the rest); **Appearance → Opacity → Mat** fades the overlay so
   you can see your real items through it (remembered); **Mat** colour is on
   the Colour panel; **☰ Menu → Redraw mat** removes it (tap twice).
5. **Turn the palm without the wound up** (your right palm when the wound is
   on your left) and hold it for half a second to hide or show the menus.
   Turning the wound's palm up just shows the wound; it never hides them.
6. Next time you enter mixed reality, the last mat is restored
   automatically (Quest's persistent anchors). It reappears where you left
   it once the headset recognises the room. Redraw replaces it.

How it finds the table height: a detected horizontal plane under the stroke
(if you've done Space Setup), otherwise a hit test straight down, otherwise
the median height of your pinch less one fingertip radius. The rectangle is
fitted with PCA on the stroke's points, refined to the tightest box near
those axes so an unclosed or wobbly loop doesn't tilt it, with its front
edge facing you. Points from your hand arriving or lifting off are ignored.

### Moving things with a fist

Anything in the headset can be moved: the material mat, every menu panel and
Buddy.

1. Put your hand **on** it, or **point your hand at it** from up to 2.5 m
   away. It lights up: the mat's edge brightens, a panel turns mint.
2. **Make a fist.** After a fifth of a second it's held (the mat's edge
   turns white), and it follows your fist.
3. **Open your hand** and it stays where it is.

The mat follows your fist in every direction, up and down included, and
turns with it while staying flat. It stays exactly where you open your
hand. If that's within 6 cm of a detected table's surface, it settles flush
onto the table. It's re-anchored where you leave it, so it's still there
next time. Panels and Buddy
follow your fist in 3D (panels turn to face you). They stay where you put
them relative to the mat, and move with it, for the rest of the session;
**☰ Menu → Reset all** puts them back.

A fist means every finger curled: the farthest of the four fingertips is
within 0.6 palm-lengths of the middle of the palm. Pointing, pinching and
fingers wrapped round a real object (about 0.8) don't count, so picking up
a tube from the mat doesn't drag the mat. A hand must open past 0.85 to let
go (`src/lib/fist.ts`; grabbing in `src/lib/grab.ts`, unit tested).

### Editing the kit

The kit is **`public/material-mat/materials.json`**. It's loaded when the
headset page opens, so changing it (and pushing, which redeploys) changes
the mat with no code changes. The headset page (after **Start mixed
reality**) lists the kit under "Material mat", so you can check an edit
without a headset. A broken file is reported there, naming the item and
field. `materials.schema.json` next to it gives editors
such as VS Code autocomplete and checking.

Each item:

| Field | Meaning |
| --- | --- |
| `id` | Unique id |
| `step` | Order on the mat and in step mode |
| `name`, `purpose`, `quantity` | Label text; quantity is the large line; purpose shows in step mode |
| `footprint` | True size in cm: `{ "shape": "circle", "diameter": 6 }`, `{ "shape": "rect", "width": 12, "depth": 7 }` or `{ "shape": "pill", "length": 15, "width": 2 }` (rects and pills run left to right) |
| `group` (optional) | Related items share a group (`"Prep"`, `"Build"`, …); each group starts a new row |
| `stages` (optional) | The build steps (1–6) the item is used in, e.g. `[2, 3]`: they light up on the mat during those steps |
| `quantityVisual` (optional) | The amount to take, shown as a true-scale hologram on a compare spot beside the outline while it's needed: `{ "type": "sphere", "diameter": 1.6 }`, `{ "type": "blob", "volumeMl": 2.5 }` (a dome of that volume) or `{ "type": "drops", "count": 3 }` (an optional `"color"` is accepted but holograms are always blue) |

The seed footprints are typical product sizes; measure your own items and
adjust them. Up to 64 items.

### Testing in the Immersive Web Emulator

1. Install Meta's [Immersive Web Emulator](https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik)
   in Chrome or Edge. Pick a **Meta Quest 3**, and switch its input to
   **hands**. To get detected planes (a table to snap to), load one of the
   emulator's rooms; without one the mat uses the pinch height.
2. Run `npm run dev`, open `http://localhost:5173/?test`, tap **Start
   mixed reality**, then **Enter mixed reality**.
3. **Simulate a pinch:** each hand's panel has a **Pinch** control. Drag it
   to 1 to pinch, back to 0 to let go. In the emulator's Play mode, hold
   the **left mouse button** to pinch the left hand or the **right mouse
   button** for the right. Pinch is detected from the fingertips (under
   1.5 cm starts, over 2.5 cm ends), so a full pinch counts. To draw,
   move the hand (its position controls, or the transform handle in the
   view) while it pinches, then release.
4. **Shortcut:** with `?test` in the URL, press **T** while in AR to trace
   a 60 × 40 cm rectangle 50 cm ahead. It goes through the same table
   snapping, fitting, anchoring and saving as a real pinch, which is
   handy for checking layouts and controls.
5. **Poke the controls:** set the hand pose to **point** and move the hand
   so the index fingertip goes into a button from the front. **Palm up:**
   rotate the left hand palm-up and hold.
6. The emulator keeps persistent anchors in the browser, so leaving and
   entering mixed reality again brings the same mat back.

### Performance

The whole mat is about 30 draw calls per eye. All outlines and fills are
one mesh, the step badges one instanced mesh, and all label text one troika
`BatchedText`. Per-slot fades and the step highlight go through
uniforms/attributes, so nothing is rebuilt per frame. Hand joints and
anchors are read with `fillPoses` into fixed buffers, and the frame loop
reuses preallocated objects throughout.

| Piece | File |
| --- | --- |
| In the headset scene (mixed reality only), session start, auto-restore | `src/mat/MaterialMat.tsx` (used by `src/components/XRScene.tsx`) |
| Kit list / errors on the headset page; extra AR features and `?test` | `src/mat/KitSummary.tsx`, `src/components/XRView.tsx` |
| Per frame: drawing → table height → fit → anchor, controls | `src/mat/xr/MatSystem.ts` |
| Hand joints, pen, palm normal | `src/mat/xr/hands.ts` |
| Pinch hysteresis, stroke buffer, rectangle fit, table choice, layout, poke, palm-up | `src/mat/lib/*.ts` (unit tested) |
| Kit loading and checking | `src/mat/lib/kit.ts` |
| Mat, slots, batches, tracing preview, stroke | `src/mat/xr/MatView.ts`, `SlotView.ts`, `slotBatches.ts`, `MatPreview.ts`, `StrokeView.ts` |
| Workspace phases, shared state, cues | `src/lib/workspaceFlow.ts` (unit tested) |
| Menus, chips, Opacity / Colour panels, Buddy's actions, cues | `src/components/XRMenus.tsx` |
| Feedback outline on the wound (verdict, scan, step done, hand lost) | `src/lib/woundOutline.ts` |
| Panel kit: fingertip presses, sliders, the pointing gate, placement around the mat; the shared look and states | `src/lib/xrPanel.ts`, `src/lib/xrPanelStyle.ts` |
| Mentor feedback: client, dev-server endpoint, prompt | `src/lib/mentorAnalysis.ts`, `src/server/mentorApi.ts`, `src/server/mentorPrompt.ts` (unit tested) |

Limits: with no Space Setup there are no planes, and hit test may find
nothing, so the table height comes from your pinch (within about a
centimetre). Anchors and persistent anchors depend on the browser; without
them the mat still appears but can drift slightly, and isn't restored next
time. Labels lie flat on the mat, facing its front edge, so they read best
from where you sat when you traced it.

## How it works

| Piece | File |
| --- | --- |
| Start screen / error screen, `?video=` test mode | `src/App.tsx` |
| Camera or test video, frame capture, detection loop, HUD stats | `src/components/ARView.tsx` |
| One canvas: background, wound, compositor (on-demand rendering) | `src/components/ARScene.tsx` |
| Captured frame as the full-screen background (or the plain mesh-view backdrop) | `src/components/VideoBackground.tsx` |
| Mesh view: grayscale hand mesh posed from the landmarks | `src/components/HandMeshView.tsx`, `src/lib/handRig.ts` |
| Lights from the skin, wound pass, camera-matching post pass | `src/components/WebcamCompositor.tsx` |
| The wound model, palm stand-in, fades, debug overlays | `src/components/WoundModel.tsx` |
| Loading and normalising `Wound.glb` (size, skin level, per-vertex shading data) | `src/lib/woundGeometry.ts` |
| Bending onto the palm (GLSL), the wound's material | `src/lib/woundShaders.ts` |
| Palm template, palm surface, wound placement | `src/lib/palmModel.ts` |
| Webcam palm pose: rigid fit, depth from palm size, jitter meter | `src/lib/webcamPalm.ts`, `src/lib/rigidFit.ts` |
| Pose smoothing (One Euro on position, size and rotation; deadband; lead) | `src/lib/poseFilter.ts`, `src/lib/oneEuroFilter.ts` |
| Skin colour / camera noise sampling, and lighting from it | `src/lib/skinSampler.ts`, `src/lib/skinLighting.ts` |
| Invisible hand that hides the wound behind it | `src/lib/handOccluder.ts` |
| Webcam landmarks → 3D hand pose, camera optics | `src/components/WebcamPoseSource.tsx` |
| Headset mode: session, VR room, workspace flow driver | `src/components/XRView.tsx`, `src/components/XRScene.tsx` |
| Headset hand joints → the same 3D hand pose | `src/components/XRPoseSource.tsx` |
| HandLandmarker setup (VIDEO mode, 1 hand, confidence 0.6, GPU → CPU fallback) | `src/lib/handLandmarker.ts` |

- **One frame per render.** The `<video>` is only a frame source. Each new
  frame (`requestVideoFrameCallback`, falling back to `requestAnimationFrame`)
  is copied once into a canvas; detection runs on that copy, and the scene
  draws the same copy as its background before rendering once
  (`frameloop="demand"` + `invalidate()`). The wound pose and the picture
  behind it therefore always come from the same frame. **Debug** shows the
  frame IDs to prove it.
- **The palm as a rigid body.** The wound is attached to one pose: the palm's.
  Only landmarks 0, 1, 5, 9, 13 and 17 (wrist, thumb base, the four
  knuckles) take part, so moving your fingers never moves the wound. Their
  shape is captured once as a template from the first 10 stable frames, then
  each frame the template is fitted to MediaPipe's metric world landmarks by
  a least-squares rigid fit (Kabsch, via Horn's quaternion method). That
  gives the rotation. Position comes from the 2D landmarks (their weighted
  centroid, corrected for perspective). Depth comes from the palm's apparent
  size: the turned template, scaled to a real 8 cm palm (index to pinky
  knuckle), is fitted to all six image points, so a tilted palm isn't read as
  a further one. MediaPipe's per-landmark image z isn't used.
- **Smoothing the pose, not the landmarks.** One Euro filters on the image
  position (min cutoff 1.2 Hz, β 0.03), on the palm's apparent size (0.3 Hz,
  on a log scale) and on the rotation (a quaternion One Euro whose speed
  term is a smoothed angular-velocity vector, so noise doesn't read as
  turning). A deadband holds the pose exactly still for changes under
  0.3 px. Since rendering is frame-locked, the only lag left is the filters'
  own; it's cancelled by stepping each axis forward along its velocity by its
  filter's lag, at most 20 ms. The filters run on the frame's capture time.
  A dropout under 150 ms keeps the last pose.
- **The wound model.** `Wound.glb` is recentred, its long axis (Z) scaled to
  6.5 cm (8 cm palm) and its thickness in proportion: rim about +2.5 mm, cut
  about −2.4 mm. Skin level is the height of the model's open outer edge,
  not its lowest point. Model +Y is the palm normal. It lies across the
  middle of the palm, parallel to the knuckle row, 45% of the way from the
  knuckles to the wrist (`WOUND_ALONG`, `WOUND_ANGLE_DEG`, `WOUND_OFFSET` in
  `src/lib/palmModel.ts`). The model's own material and UVs aren't used.
- **Bent onto the palm.** The palm's surface is a bilinear patch through the
  template's wrist, thumb base, index and pinky knuckles, minus a 3 mm cup
  in the middle, raised 1.5 cm (`PALM_SKIN_LIFT`). The landmarks are joint
  centres inside the hand, and the skin lies above them. Without the lift
  the wound would sit inside the hand and slide over the skin whenever the
  palm turns. The vertex shader places each wound vertex on that surface
  and raises it along the surface normal by its height, turning its normal to
  match, so the wound wraps the palm. All of it happens on the GPU from a few
  uniforms; the object's matrix is just the palm pose. The wound fades out
  between 55° and 75° away from the camera.
- **Looking real.** A custom physical material (`onBeforeCompile`):
  - Colour comes from each vertex's height and nearness to the cut: blood
    #3a0508–#5a0a0f in the depths and raw #8b1a1a walls with mottling.
  - The swollen lips are your skin exactly as the camera sees it, shaded
    only by how their shape catches the light compared with a flat palm, so
    there's no border or shadow ring. Everything near skin level fades to
    transparent, so the real skin shows there.
  - Wet clearcoat (roughness 0.1) is only in the cut; elsewhere roughness is 0.6.
  - Occlusion comes from depth and creases.
  - Procedural micro-bumps.
  - Subsurface scattering is faked with wrapped lighting and a red tint.
  - Soft reflections come from a studio environment map.
- **On the skin.** Every few frames the skin around the wound is read from a
  small downscaled canvas. The ambient and directional lights follow its
  brightness and colour, and the rim takes its tone.
- **Camera matching.** The wound is rendered on its own and laid over the
  picture with a 0.7-camera-pixel blur, grain the size of a camera pixel at
  the measured noise level, and slightly lower saturation and contrast.
- **Occlusion.** An invisible stand-in for your hand (finger capsules plus the
  palm surface, 6 mm behind the skin) writes depth only, so curled fingers or
  the back of the hand hide the wound. If fingers cover a lot of it, it fades
  out rather than showing slivers. `src/lib/handOccluder.ts`.
- **Closed hand.** When the fingertips come in towards the wrist (openness
  below 1.15, back above 1.3) the wound fades out over 200 ms and the status
  pill says "Open your hand".
- **Mesh view.** The skinned "generic hand" from the WebXR input profiles
  (`public/models/`, MIT licence, see `LICENSE-generic-hand.md`) is posed
  bone by bone: each bone's direction comes from its landmark and the next
  one, its roll from the back-of-hand direction, and the whole model is scaled
  to your palm length. In this view the wound is lifted onto the model's palm
  surface and skin and camera matching are switched off.
- **Performance.** Detection runs once per new camera frame; all per-frame
  maths reuses preallocated objects and buffers; per-frame data lives in refs
  (no React renders) and the HUD updates twice a second. **Stop** cancels the
  loop, closes the landmarker and stops the camera.

## Tuning

- `src/lib/palmModel.ts`: where the wound sits (`WOUND_ALONG`,
  `WOUND_ANGLE_DEG`, `WOUND_OFFSET`), the palm's cup (`PALM_BOW`), the
  assumed palm size.
- `src/lib/woundGeometry.ts`: the wound's length (`WOUND_LENGTH`) and how
  wide its edge blends into the skin.
- `src/lib/woundShaders.ts`: `WOUND_LOOK` (colours, wetness, subsurface,
  occlusion, micro-bumps).
- `src/lib/poseFilter.ts`: smoothing, deadband and lead.
- `src/components/WoundModel.tsx`: fade angles, finger-coverage fade.
- `src/components/WebcamCompositor.tsx`: blur, saturation, contrast, grain
  bounds.

## Known limits

- The hand stand-in is an approximation (finger capsules and the palm
  surface), so the wound's cut-off edges follow your hand only roughly.
- Depth assumes an 8 cm palm and a ~41° webcam field of view. A smaller or
  larger hand, or a wider lens, makes the wound a little too large or small
  (it still stays in place on the image).
- The palm's shape is captured when the hand comes into view. If that
  happens while the palm is strongly cupped, the surface keeps that shape
  until the hand leaves the view for a second and comes back.
- The palm surface follows six landmarks and a fixed cup; it doesn't follow
  palm creases or fine skin folds.
- Light matching assumes the light falls on the palm roughly as it does on
  the reference skin tone; very coloured lighting is matched only halfway.
- The WASM URL uses `@latest` as specified; if a future MediaPipe release
  breaks compatibility with the installed npm package, pin the URL to the
  version in `package.json`.
