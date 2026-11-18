# LightShow

BMW light show sequencer and DRL brightness control for the G01 X3, running on the MGU head unit (iDrive 7 / iDrive 8).

## Pages

| Page | What it does |
|------|-------------|
| **Strobe** | Pick a pattern, set the speed, and play a choreographed light show using real-time IOControl commands to the BDC. A live car diagram shows which lights are on. |
| **DRL** | Set DRL LED brightness on both headlight modules (FLM left + right). |

## Patterns

| Pattern | Description |
|---------|-------------|
| Wig-Wag | Alternating left-right headlights |
| Dual Flash | All lights flash on and off together |
| DRL Alternate | DRLs alternate left and right |
| Front / Rear | Front lights then rear lights |
| Sequential | Lights sweep left to right then back |
| Strobe Front | Rapid high beam strobe |
| Red & Blue | Alternating left-right rapid flash |
| Random | Random lights at random intervals |

## How it works

### Strobe (IOControl)

The strobe sequencer sends **InputOutputControlByIdentifier** (service 0x2F) commands to the BDC to toggle individual light circuits on and off in timed patterns:

- `0x2F <DID> 03 01` — turn a light on (shortTermAdjustment)
- `0x2F <DID> 03 00` — turn a light off
- `0x2F <DID> 00` — return control to ECU (restore)

When the show stops, every controlled light is restored to ECU control.

### DRL brightness (coding)

1. Reads the FLM coding block with **ReadDataByIdentifier** (service 0x22)
2. On a tap, enters an **extended diagnostic session** (0x10 03)
3. Writes the modified block with **WriteDataByIdentifier** (0x2E)
4. Returns to the **default session** (0x10 01)

## Control units

| Address | Unit | Used for |
|---------|------|----------|
| 0x40 | BDC (body) | Light output IOControl (strobe) |
| 0x43 | FLM left headlight | DRL brightness coding |
| 0x44 | FLM right headlight | DRL brightness coding |

## Light outputs (BDC IOControl)

| DID | Light |
|-----|-------|
| 60FD | Low Beam L |
| 60FE | Low Beam R |
| 60FF | High Beam L |
| 6100 | High Beam R |
| 6101 | DRL L |
| 6102 | DRL R |
| 6103 | Front Fog L |
| 6104 | Front Fog R |
| 6105 | Turn Signal L |
| 6106 | Turn Signal R |
| 6107 | Tail Light L |
| 6108 | Tail Light R |
| 6109 | License Plate |
| 610A | Rear Fog |

## Files

| File | What it is |
|------|-----------|
| `main.js` | The app: pages, drawing, user interaction |
| `strobe.js` | Light definitions, pattern library, sequencer engine |
| `link.js` | Diagnostic link (coding reads/writes + IOControl, with allowlist) |
| `coding.js` | DRL brightness option definition |
| `demo.js` | Demo mode: simulated ECU and IOControl responses |
| `app.json` | App manifest |
