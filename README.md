# Verse: kinetic lyrics for Spotify (macOS)

Verse reads what the Spotify desktop app is playing and pulls time-synced lyrics from LRCLIB. It animates them as kinetic typography that changes style with the song's energy.

## Build & run

Open Terminal in this folder and run:

```bash
./build.sh            # builds build/Verse.app and opens it
./build.sh --install  # also copies it to /Applications
```

You need the Xcode Command Line Tools. If you don't have them, run `xcode-select --install` first.

## First launch: permissions

1. **Automation → Spotify**: macOS asks "Verse wants to control Spotify". Click **Allow**. This lets Verse read the track name and playback position.
2. **Screen & System Audio Recording**: this is optional and only powers the beat reaction. Turn on Verse in System Settings → Privacy & Security, then reopen the app. Without it, Verse still works and guesses the energy from how fast the lyrics move.

Each time you rebuild, the ad-hoc signature changes, so macOS may ask again.

## How it moves

| Energy | Look |
|---|---|
| Calm (quiet, few beats, slow lyrics) | Mixed case, words fade up out of a blur |
| Mid | Uppercase justified stack, words wipe up through masks |
| High (loud, dense kicks, fast lyrics) | Heavy stacked rows, words slam in with overshoot, the key word gets its own row, camera shake and flash on every kick |

The colours come from the album art. Each line picks its style when it starts, so a line never changes style halfway through.

## Controls

| Key | Action |
|---|---|
| `]` / `[` | Lyrics earlier / later by 0.1 s (hold Shift for 0.5 s). Use this for Bluetooth delay. |
| `0` | Reset sync |
| `⌘R` | Re-fetch lyrics |
| `⌘T` | Float on top |
| `⌃⌘F` | Full screen |
| `⇧⌘A` | Turn beat reaction on/off |
| `D` | Debug overlay (energy, mode, audio levels) |

## Files

- `Sources/main.swift`: the window, menus, the bridge to the web layer, and native fetching
- `Sources/SpotifyPoller.swift`: reads Spotify through AppleScript every 0.5 s
- `Sources/AudioTap.swift`: captures system audio with ScreenCaptureKit and turns it into loudness, bass and kick onsets
- `web/app.js`: the animation engine (layout, timing, modes)
- `web/index.html?demo`: open this in any browser to preview the animation without Spotify
