# Blocky World

A joyful voxel game with three modes: build, fight, and observe. It runs in a modern browser without a build step or external runtime assets, and keeps the offline single-player path.

## Offline single-player

Open `index.html` in a browser. This starts the game locally without contacting a server. Existing browser saves are migrated locally when the game recognizes the previous save format.

## Family LAN server

The Windows host needs Node.js installed. Double-click `start.bat` on the family PC and leave its console window open while the server is in use. It starts on port 8082 and displays the local network address and, only before first setup, a one-time setup code. Keep this port available for the configured Tailscale Funnel target. `allow-firewall.ps1` reads the active port recorded by the server.

On each device connected to the same home Wi-Fi:

1. Open the displayed address in a browser. On iPhone or iPad use Safari; **Add to Home Screen** is optional.
2. On first use, enter the one-time code shown only in the PC server window. Set a PIN for Florenz, Marlene, and Feng. The server stores salted PIN hashes on the PC; PINs are not included in the browser code or repository.
3. On an existing two-profile server, open the game on the family PC once to add Feng's PIN. Enter the one-time profile setup code shown in the PC server window; the existing Florenz and Marlene PIN hashes and world saves are preserved. The code is required because Tailscale Funnel also reaches the server through a local connection.
4. On later visits, select Florenz, Marlene, or Feng and enter that profile's PIN.

Each profile's saved world is stored separately under `.blocky-world-data/` on the PC. The folder is excluded from Git and is not served to browsers. Stopping the server invalidates active sessions; restart it manually with `start.bat`. If Windows Firewall blocks the connection, run `allow-firewall.ps1` on the PC while it is connected to a trusted home network; it adds a rule for the Private network profile only.

The server still uses HTTP between the PC and its local interface. For remote play, keep the PC signed in to Tailscale and configure Tailscale Funnel to forward HTTPS on your Funnel hostname to http://127.0.0.1:8082. Keep start.bat running on the PC. Do not enable router port forwarding. Profile PINs are short and are not designed to resist sustained internet guessing, so treat Funnel access as a limited family demo and do not use sensitive data. Funnel supplies the public HTTPS endpoint; the game server itself remains on the family PC.

Live visits support Play & Build, Fight Arena, and Observe World for Florenz, Marlene, and Feng. The owner starts hosting, approves each visit, and remains online; signing out or disconnecting ends access. In Play & Build, both players can edit and visitor changes save into the owner's world. Fight Arena visitors choose Duel or Co-op vs computer with the host; Observe World shares the owner's world.

## The three modes

**Play & Build** — Explore, break blocks, and place blocks. Flying starts enabled; use **FLY** to toggle and **▲▼** to move vertically. Each character uses their Fight Arena maximum health. Left-click or tap **BREAK** to attack animals or a visiting player; fist, wood, stone, and gold attacks deal 8, 12, 16, and 20 damage. Select a wood, stone, or gold block to use that material's attack strength; other selections use a fist. Animals have 30 health, retaliate for 5 damage no more than once per second after being hit, and each defeated animal gives one meat. Breaking leaves has a 15% chance to give one apple. Select food and use right-click or **PLACE** to eat it; an apple restores 20 health and meat restores 30. At zero health, the player respawns at their spawn after 2.4 seconds at full health; world edits and food inventory remain.

**Fight Arena** — Choose characters and fight in a generated arena. On a phone, the second fighter is computer-controlled; a connected controller can take over.

**Observe World** — See the world from different camera views and take a photo.

## Original characters

The roster includes Steve, Alex, Web Hero, Dolly, Stone Golem, and Fire Ninja. Keep every character visually original: use broad themes such as a friendly web-slinging hero or a cheerful imaginative doll, and avoid recognizable names, costumes, logos, faces, or signature details from existing franchises.

## Controls

On a phone or tablet, use the on-screen thumbstick to move, drag the right side to look, and use the large **BREAK / PLACE / JUMP / FLY** buttons. **BREAK** attacks animals and visiting players; select Apple or Meat in the hotbar, then press **PLACE** to eat. Scroll the hotbar to reach food. In a fight the buttons become **HIT / SKILL / JUMP / FLY**. Controls support touch-only play.

On a desktop, use **WASD** to move, the mouse to look, left click to break or attack, right click to place or eat selected food, **1–9** for blocks, **0** for the shovel, and the mouse wheel or hotbar click for food. **F** toggles flight, **J / K / L** control fight actions, **V** switches between third- and first-person view, **F5** changes camera, **P** takes a photo, and **F10** pauses.

A second local player can use a gamepad or arrow keys plus Numpad 1 / 2 / 3.

## World and saves

- The world is 200,000 × 200,000 blocks and 100 blocks tall. Nearby chunks generate as you explore, and distant chunk memory is released. **Reset World** rolls a new seed. Choose between a hilly **Normal World** and a level, treeless **Flat World**. Each world keeps its own edits, seed, and player position; **Reset World** rolls a new seed for the selected world only.
- Water spreads into nearby open cells for a short, bounded distance, refills a dug cell when supported by a nearby source, and retracts unsupported flow after its source is removed. Placing a block displaces water; removing that block lets supported water flow back.
- Terrain, textures, and sounds are generated by the game; it loads no external runtime assets.
- World edits, seed, player position, settings, character picks, and food inventory save automatically. Offline saves remain in the browser; LAN profile saves stay on the PC. Older saves keep their existing terrain and edits while the game moves their coordinates into the expanded map. The browser keeps a temporary profile-scoped recovery copy until the PC confirms the save, so a pending save can be recovered in the same browser after a tab closes. If the PC world changes before recovery, the game asks whether to restore the browser copy over the PC world or keep the newer PC world.
- The server is built with Node.js built-ins and has no third-party runtime dependencies.

## Memory-only QA preview

Public GitHub Pages staging is approved only for this sanitized static QA preview. It contains no family, server, account, or PIN data, and save data exists only in the current page's memory; reloading starts with a fresh world. This approval does not cover the normal game or family server. The sanitized QA previews are staged on the separate `codex/public-staging-pages` branch at [Storybook preview](https://fengguode.github.io/Blocky_World_GUO/issue-27/) and [animal preview](https://fengguode.github.io/Blocky_World_GUO/issue-28/).

`npm ci` installs the build-only minifier. Run `npm run build:qa` to create a static, network-free preview in `.qa-public/`. The QA entry omits the server bridge and shared-visit paths and keeps saves only in the current page's memory; reloading the page starts with a fresh world. It retains offline world generation, rendering, Fight Arena, and Observe World. The normal `index.html` and its persistent offline saves are unchanged.

The build fails if the generated preview contains server, visit, network transport, or persistent browser-storage references. It is intended for the separate QA staging flow and does not publish or deploy the preview.

## Tests

The repository has an opt-in test runner. Run it only when requested:

```
node tests\run.js
node tests\run.js Meshing
node tests\run.js --verbose
node tests\run.js --list
```

## Source files

```
index.html      page, profile sign-in, and HUD
style.css       styling, including touch controls
serve.js        LAN server entry point
server.js       access control, sessions, and per-profile storage
start.bat       manually starts the Windows LAN server
js/blocks.js    block table and procedural textures
js/gl.js        WebGL2 helpers and matrix maths
js/world.js     terrain generation, chunks, lighting, and saved edits
js/mesher.js    chunk-to-GPU mesh generation
js/chars.js     original character definitions
js/input.js     keyboard, mouse, and gamepad
js/touch.js     touch controls
js/camera.js    camera modes and observe views
js/entity.js    players, animals, projectiles, and particles
js/bot.js       computer opponent
js/fight.js     combat and special moves
js/ui.js        menus, HUD, and sound
js/main.js      state machine, saves, rendering, and frame loop
js/network.js   profile sign-in and server-save bridge
```


