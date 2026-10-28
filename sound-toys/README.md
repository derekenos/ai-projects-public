# Sound Toys

Three browser instruments from ideas on derekenos.com/etc. Plain HTML and
JavaScript with no build step and no audio files: every sound is synthesized in
`common/kit.js`. All three are gamepad-first (standard USB pad), with the
keyboard mirroring the same buttons.

| App | Idea | Open |
|---|---|---|
| Wave & Wheel | Wave-based Audio Sequencer + Traffic Wheel Sequencer | `wave-wheel/index.html` |
| ENDO | ENDO | `endo/index.html` |
| Beatbox → Drums | Voice-controlled Drum Sequencing | `beatbox/index.html` |

## Running

Opening the files directly works for everything except, in some browsers, the
microphone and Web MIDI, which need a secure context. Serving over localhost
covers all of it:

    cd /workspace/sound-toys && python3 -m http.server 8000
    # then http://localhost:8000/endo/ etc.

Keyboard stand-ins for the pad: arrows = D-pad, Z/Space = A, X = B, C = X,
V = Y, Q/E = LB/RB, 1/3 = LT/RT, Enter = Start, Tab = Select, IJKL = right stick.

## Layout

    common/input.js    gamepad + keyboard as one set of virtual buttons
    common/kit.js      synthesized drum/instrument kit, reverb, scales
    common/dsp.js      FFT and windowed magnitude spectrum
    wave-wheel/        sequencer (app.js)
    endo/              kick-driven animation (app.js)
    beatbox/           analysis.js (onsets, features, classifier, tempo,
                       quantize, MIDI export) + app.js (UI)
