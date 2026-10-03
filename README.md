# Hack-for-humanity

**ModalForge** makes footstep sounds from physics instead of recordings. Pick a floor (pine, oak, garden deck,
steel catwalk, glass or concrete), walk across it in the browser, and download the sound. **Quanscient Allsolve**
solves how the floor vibrates in 3D, and the browser turns those vibrations into sound. No samples are used, so
every step is unique and matches the floor, shoe, walker and room.

→ The app, setup and full documentation are in [modalforge/](modalforge/README.md).

## Impact
Footsteps are among the most repeated sounds in games, film and VR. Most come from a small set of recordings,
so they repeat, and a new floor means a new recording session. ModalForge produces footsteps for any floor and any
footwear, which gives small teams and independent creators realistic, varied sound without a studio or a sample
library. The output is ready to use: WAV files, surround mixes and ready-made Unreal Engine and game-engine packs.

## Functionality
A working prototype:
- **Instant preview** in the browser with no API key, using textbook plate formulas.
- **Full 3D solve on Allsolve**, with Draft, Standard and Fine detail levels. A Draft solve takes about 2 minutes,
  and each result is saved so that floor loads instantly afterwards.
- **Sound** for walking, running and debris (gravel, glass, leaves, snow), heard through headphones (3D), stereo,
  5.1 or 7.1, with room echo.
- **Export** as single steps, whole walks, or complete game-engine sound packs.

## Creativity
Footstep tools usually play back recordings. ModalForge does it the other way round: it simulates the structure
(deck boards, joists, materials, supports), finds its vibration modes with a cloud FEM solver, and builds the sound
from them. You can hear what the 3D solve adds: switch between the textbook preview and the Allsolve result on the
same step, and the app marks the modes where the joists move with the boards, which the simple model can't produce.

## Presentation
The demo shows the same footstep on wood and then on a steel catwalk, then compares the textbook preview with the
Allsolve result on the same step, and ends with exporting a sound pack. A **Math** view in the app traces every number
from floor to sound and labels where it came from (Allsolve, computed locally, or assumed), so the physics is
open to inspection. Our Allsolve SDK experience and suggestions are in the
[SDK feedback log](modalforge/README.md#allsolve-sdk-feedback-log-judging-criterion-3).

## Scalability
- **New floors are data, not code.** Materials and surfaces live in one JSON file.
- **Each floor is solved once in the cloud.** After that it is reused from the saved results, and floors can be
  solved ahead of time in bulk with `scripts/precompute.py` (in parallel with an organization key).
- **The sound engine runs in any browser** and the exports drop straight into Unreal, Unity, FMOD and Wwise.

Next steps would be a game-engine plugin that synthesises steps live, more structure types (stairs, bridges,
raised floors), and acoustic design of real buildings, so architects could hear a floor before it is built.
