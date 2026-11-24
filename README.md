# Firefly Choir

[![Build APK](https://github.com/MhamzaM/firefly-choir/actions/workflows/build.yml/badge.svg)](https://github.com/MhamzaM/firefly-choir/actions/workflows/build.yml)

**Flash your lantern in rhythm with the fireflies until the whole meadow lights up as one.**

A small, free Android game from [FreeApps by Hamza](https://mhamzam.github.io). No ads, no tracking, no internet permission.

## How it plays
- Each firefly glows brighter just before it flashes.
- Tap to flash your lantern. Fireflies close by flash sooner and fly toward your light.
- Flash together with a group and its neighbours join in. Get every firefly flashing at once before dawn.
- Later nights bring more fireflies, wind gusts that scatter the rhythm, and red *mimics* that flash out of turn. Tap a mimic to chase it away.

The dawn creeping across the sky is the timer. Every firefly has its own note, so a meadow in sync plays a chord.

## The science
Some firefly species really do flash in unison. Each firefly is a *pulse-coupled oscillator*: an internal clock that triggers a flash, and seeing a neighbour flash nudges that clock forward. The game simulates exactly that, and your lantern is one more (very bright) firefly. The red mimics are inspired by *Photuris* fireflies, which copy other species' flash signals.

## Tech
- The game is plain HTML5 canvas + JavaScript in `app/src/main/assets/game/`, with sound synthesised by the Web Audio API (no audio files).
- The Android app is a single Java activity that shows it in a full-screen WebView. No libraries.
- Permissions: vibration only.

You can also play it in a browser: open `app/src/main/assets/game/index.html`.

## Build
Open the folder in Android Studio and press Run, or run `./gradlew assembleDebug`. Every push builds an APK with GitHub Actions; pushing a tag like `v1.0` publishes a release with `FireflyChoir.apk` attached.
