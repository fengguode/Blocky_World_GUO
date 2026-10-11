# Play & Build health and combat browser smoke

Date: 2026-10-11 (Asia/Shanghai)

## Isolated fixture

- Candidate source was copied to `C:\Users\guofe\AppData\Local\Temp\play-build-health-browser-3db6543c2e754ad399e06778e1528133`.
- The browser server was node PID `130316`, launched with that directory as its working directory. The served `server.js` resolves `.blocky-world-data` under `__dirname` and binds to `127.0.0.1`; the browser used `http://127.0.0.1:8081`.
- Port 8080 was already occupied when the earlier fixture start attempted it. That process was not stopped or changed. Only the disposable fixture server on 8081 was restarted during these checks.
- The login request used synthetic profile ID `p1` and PIN `123456`. The fixture accounts file contained only `p1`/`p2`/`p3` disposable test accounts. The app's visible profile label for `p1` is “Florenz”; no family account or world data was used.
- The current-format `world-p1.json` contained `worldSize: 200000`, inventory `apple: 2, meat: 3`, and four test block edits. A normal save reached revision 1 while retaining the marker and edits. After reloading and re-entering Play & Build, the browser reported `Game.saved.worldSize === 200000`, inventory 2/3, four edits, and block ID 2 at `(199995, 80, 199995)`.

## Gameplay results

The visible browser flow signed in, opened Play & Build, loaded the HUD and world, and reloaded the saved world. Controlled synthetic gameplay methods were invoked in-page to target a known animal and set deterministic damage amounts:

- Pig health 30 reached 0 after two successful Gold attacks; a third attack was rejected, and meat increased from 3 to 4.
- Player damage reduced HP from 100 to 70. Apple consumption increased HP by 20 to 90 and reduced apples by one. A further 20 damage followed by Meat consumption increased HP by 30 to 100 and reduced meat by one.
- Lethal damage set HP to 0 and the KO timer to 2.4 seconds. Advancing the actual player update by 2.401 seconds restored HP to 100 and cleared KO while retaining inventory 2/3, all four edits, and the test block.
- Server-side visitor attack/range/facing/cadence behavior was checked by the disposable multiplayer regression suite (8 checks passed).

## Viewports and console

- Desktop screenshot: `play-health-desktop-final.png` at 1200×900 CSS pixels.
- Touch-emulated screenshot: `play-health-touch-emulated-clean-390x844.png` at 390×844 CSS pixels in Playwright Chromium with `isMobile: true` and `hasTouch: true`. The page reported `navigator.maxTouchPoints === 1`, `Game.isTouch === true`, and all six movement/look/action controls visible. This verifies touch emulation and layout; no physical iOS/Android hardware was used.
- The equipment summary is positioned below the top debug/settings row on touch-sized screens and clear of the action buttons in the captured layout. Food hotbar slots remain horizontally scrollable on narrow screens.
- Browser console: 0 errors and 0 warnings in the desktop session; 0 errors in the touch-emulated session.

Screenshots capture a disposable generated world and contain no family save content.
