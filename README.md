# BRC 3D Print Price Calculator

Price calculator and invoice generator for the Bingham Research Center's Bambu H2C 3D print service. Single self-contained HTML page, no build step.

Live: https://bingham-research-center.github.io/brc-print-calculator/

The public page shows the External tier, which covers everyone outside BRC, USU students and staff included. Staff: append `?brc` to the URL to also show the internal BRC tier, which pays materials, print time and setup but no labor and no sales tax.

To update prices, edit the `MATERIALS` / `TIERS` / `COLOR_OPTIONS` constants at the top of the `<script>` block in `index.html`.

**Quantity** is for identical copies of one item. Weight and print time are entered per copy; labor, setup, and the special-handling surcharges are charged once per job. The pricing rules sit between `BRC_PRICE_START` and `BRC_PRICE_END` in `index.html` and are covered by `node --test`.

## Model files

Drop a file on the "Model or sliced file" box (or click it) and the weight and print time fill in. Files are read in the browser and never uploaded.

- **Bambu Studio `.gcode` or sliced `.3mf`** (File > Export > Export plate sliced file): the slicer's own time and weight, exact. The material is selected from the filament type, and Quantity resets to 1 because the file already covers its whole plate; set it to the number of plates if the same plate prints more than once.
- **STL / 3MF / OBJ**: a geometric estimate. The page computes mesh volume, surface area, height, and overhang area, then applies the H2C "0.20mm Standard" profile (2 walls, 5 top / 3 bottom layers, 15% infill) and a simple time model. Expect roughly +/-20% on weight and +/-30% on time. Supports get ticked automatically when the overhang area is significant. The final quote should come from the real slice.

With a quantity above 1, the estimate spreads the pre-print overhead (`fixedSeconds`, `fixedGrams`) across the copies, assuming they print on one plate.

**Print quality** only affects the model-file estimate: the fine-detail option (0.12 / 0.08 mm) uses thinner layers and 40 percent of the flow rate, which is what the H2C High Quality profiles measured at on a 0.12 mm PLA statue and a 0.08 mm PETG bracket. Sliced files carry their own layer height.

STEP files are not supported; export STL or 3MF instead.

### Calibrating the estimate

The knobs are the `EST` constants and the `density` / `flow` fields in `MATERIALS`, next to the pricing constants in `index.html`. Open the page with `?brc` and drop a Bambu Studio project `.3mf` that was saved after slicing (File > Save project): it holds both the mesh and the slicer's numbers, and the status line shows what the estimate model would have predicted next to them (details in the browser console). An exported `.gcode.3mf` gives exact numbers for quoting but carries no mesh, so it cannot feed the calibration check. Adjust `flow` (mm³/s per material) and `layerSeconds` until a few real prints of different sizes line up. `fixedSeconds` is the pre-print time (leveling, purge line) and `fixedGrams` the purge line. `supportDensity` and `supportFlow` govern tree support: how much material it adds and how slowly it prints. `QUALITY` holds the layer height and flow scale behind the Print quality select.

The 2026-09-03 fit used eleven H2C slices: keychain plates, a PETG sign, box-shaped cases, a can topper, a 16 h PETG dragon with tree supports, a Pi case with hundreds of mesh holes, a 0.12 mm PLA statue, a 0.08 mm PETG bracket, and a four-color painted PLA python. On the default 0.20 mm Standard profile, weight runs 0 to 15 percent high on ordinary parts and up to 65 percent high on flat parts with small lettering. Time sits within about 20 percent for typical parts, but plain boxes come out about 20 percent slow and parts with hundreds of tiny features (mesh grilles) about 30 percent fast, and no constant separates those two without slicing. Prints on other profiles (0.12 mm, painted multi-color with flushing) fall outside the model, and only the real slice is worth quoting from.

## Tests

```
node --test
```
