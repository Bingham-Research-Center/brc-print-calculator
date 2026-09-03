# BRC 3D Print Price Calculator

Price calculator and invoice generator for the Bingham Research Center's Bambu H2C 3D print service. Single self-contained HTML page, no build step.

Live: https://bingham-research-center.github.io/brc-print-calculator/

The public page shows the External tier, which covers everyone outside BRC, USU students and staff included. Staff: append `?brc` to the URL to also show the internal BRC tier, which pays materials, print time and setup but no labor and no sales tax.

To update prices, edit the `MATERIALS` / `TIERS` / `COLOR_OPTIONS` constants at the top of the `<script>` block in `index.html`.

**Quantity** is for identical copies of one item. Weight and print time are entered per copy; labor, setup, and the special-handling surcharges are charged once per job. The pricing rules sit between `BRC_PRICE_START` and `BRC_PRICE_END` in `index.html` and are covered by `node --test`.

## Model files

Drop a file on the "Model or sliced file" box (or click it) and the weight and print time fill in. Files are read in the browser and never uploaded.

- **Bambu Studio `.gcode` or sliced `.3mf`** (File > Export > Export plate sliced file): the slicer's own time and weight, exact. The material is selected from the filament type.
- **STL / 3MF / OBJ**: a geometric estimate. The page computes mesh volume, surface area, height, and overhang area, then applies the H2C "0.20mm Standard" profile (2 walls, 5 top / 3 bottom layers, 15% infill) and a simple time model. Expect roughly +/-20% on weight and +/-30% on time. Supports get ticked automatically when the overhang area is significant. The final quote should come from the real slice.

With a quantity above 1, the estimate spreads the pre-print overhead (`fixedSeconds`, `fixedGrams`) across the copies, assuming they print on one plate.

STEP files are not supported; export STL or 3MF instead.

### Calibrating the estimate

The knobs are the `EST` constants and the `density` / `flow` fields in `MATERIALS`, next to the pricing constants in `index.html`. Open the page with `?brc`, drop a sliced `.gcode.3mf` exported from Bambu Studio, and the status line shows what the estimate model would have predicted next to the slicer's real numbers (details in the browser console). Adjust `flow` (mm³/s per material) and `layerSeconds` until a few real prints of different sizes line up. `fixedSeconds` is the pre-print time (leveling, purge line) and `fixedGrams` the purge line.

## Tests

```
node --test
```
