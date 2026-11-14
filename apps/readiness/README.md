# Readiness

Emissions readiness and emission faults, nothing else: a progress bar with one segment per readiness monitor this
car has, which monitors are complete, the emission faults stored, and the driving that completes the rest.
It only reads. Nothing is written, coded, cleared, reset or actuated.

## Pages

| Tab | What it shows |
|---|---|
| **Readiness** | A verdict (READY, ALMOST READY with one monitor left, NOT READY, or CHECK ENGINE ON), the progress bar and percentage, the check engine lamp (MIL), the fault count, and the distance, warm-ups and time since faults were last cleared. Below that are the monitors, each marked complete, incomplete or not supported, and the driving style to use now with the first three steps. |
| **Faults** | The engine unit(s)' and gearbox's fault memory as BMW's own tools show it: BMW hex codes such as `190302`, with BMW's text, the readiness system each one belongs to, the unit, and its state (ACTIVE, MIL ON, STORED or PENDING). Faults of a readiness system come first, then the others. Any generic OBD-II P-codes the car also reports (services 03, 07, 0A) are listed with them, but most BMWs report none. |
| **Drive plan** | The steps that complete the incomplete monitors, in order: cold start, gentle warm-up, steady cruise, coast-downs, A/C, and parking overnight for the evaporative leak test. Each step names the monitors it completes, and the header counts the ones completed during this drive. |

## Monitors

Misfire, fuel system, components, catalyst, heated catalyst, evaporative system, secondary air system, A/C refrigerant,
oxygen sensor, oxygen sensor heater and EGR system (SAE J1979 PID 01).

Most BMW engine units don't answer OBD-II service `01` over the head unit's diagnostic link. They give the same PIDs
as UDS identifiers `22 F4 <PID>` (ISO 27145), as Car Vitals reads them. The app asks `22 F4xx` first and falls back
to `01`, then keeps to whichever the unit answered.

- **Heated catalyst, secondary air and A/C refrigerant** are optional. The car's first answer says whether it has
  them, and any it lacks are left out for the rest of the session.
- Any other monitor the car lacks stays on screen as *not supported* and doesn't count towards the progress bar.
- On a diesel engine the same bits mean different monitors (NMHC catalyst, NOx/SCR, boost pressure, exhaust gas
  sensor, particulate filter, EGR/VVT), so a diesel gets those names.
- An engine with two engine units (V8, V12) shows both as one: a monitor counts as complete only when every unit
  that runs it reports it complete.

## BMW fault codes

BMWs keep their faults as BMW hex codes in each unit's fault memory (UDS `19 02`), not as generic `P0xxx` codes. The
app reads that memory from the engine unit(s) and the gearbox, asking for pending and stored faults (status mask `0C`,
the same as Fault Scanner's *Current*).

- **Texts.** These come from `bmw_dtc.pack`, the engine unit and gearbox part of Fault Scanner's committed database
  (about 22,000 codes, 48 engine and gearbox types, 1.1 MB). The app first asks each unit for its type
  (`22 F1 50`), so the text matches that exact engine or gearbox. If the type isn't known, it falls back to the text
  every type at that address agrees on. Fault Scanner isn't in this repository; after its database is updated
  upstream, run `python3 kit/tools/readiness_texts.py <path to upstream apps/dtc_scanner/dtc_db.pack>` to rebuild
  the pack.
- **Readiness system.** Each code is linked to a readiness system using the subject of its BMW text, the part before
  the colon. For example, "Oxygen sensor heating, ...: Circuit open" belongs to *Oxygen sensor heater*, and
  "DMTL, ..." or "Tank vent valve, ..." belongs to *Evaporative system*. A fault that only mentions a system in its
  symptom, bus messages and temperature sensors are shown as *Other*.
- **Effect on the plan.** A stored or active fault of a readiness system moves the drive plan's first step to *Fix
  the fault first*, because its monitor may not run until it is repaired.

The drive plan is generic guidance. Each manufacturer and engine sets its own enable conditions, so a monitor
can need more than one drive.

## How it reads

- **Only reading.** All requests go through `link.js`. It keeps the head unit's diagnostic link private and refuses
  everything except these requests, all checked before anything reaches the transport:
  - `01` with one PID from `00 01 20 30 31 40 41 4E`
  - `03`, `07` and `0A` with no data
  - `19 02 <mask>` to read BMW's fault memory: only sub-function `02`, so no `19` sub-function that does anything else
  - `22 F1 50` to read the unit type, and `22 F4 <PID>` with the same PIDs as `01`: no other identifier
  - only to the engine unit (`0x12`), the second engine unit (`0x13`) and the gearbox (`0x18`)
  - never to all units at once

  OBD service `04` (clear faults), UDS `14`, sessions, writes, routines, I/O control and tester present are all
  refused. The test checks that each one is refused and that a refused request never reaches the transport.
- **Gently.** One request at a time, at least 40 ms apart, and only while the app's screen is shown. Readiness is
  read every 10 s, and faults and the since-cleared counters every 30 s. *Refresh* reads everything again. A unit
  that doesn't answer 4 times in a row is skipped until the next Refresh. With no answer at all (ignition off), it
  tries again every 30 s. The fault memory is read even when readiness gets no answer, and the Readiness page shows
  what each engine unit replied (refused, and why, or no reply).
- **Nothing on disk.**

## Settings

| Setting | Default | |
|---|---|---|
| Speed and distance | km/h, km | or mph, miles |
| Colour theme, layout, renderer | as the other apps | |
| Demo data | Auto | a demo car when the head unit has no diagnostic link |

## Build and test

```sh
python3 kit/tools/build.py readiness
node kit/tools/test_readiness.js        # guard, decoding, drive plan, and the app on a fake head unit
PREVIEW=preview node kit/tools/test_readiness.js   # also saves each page as a PNG
```
