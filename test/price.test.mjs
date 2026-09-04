// Run with: node --test
// Extracts the BRC_PRICE block from index.html and checks the pricing rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('/* BRC_PRICE_START */'), end = html.indexOf('/* BRC_PRICE_END */');
assert.ok(start > 0 && end > start, 'BRC_PRICE block not found in index.html');
const P = new Function(html.slice(start, end) + '\nreturn { price, priceRange, buildLines, MATERIALS, TIERS, TAX_RATE, PROCESSING_FEE_RATE, EST, QUALITY, COLOR_OPTIONS };')();

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const pla = P.MATERIALS[0];
const job = (over) => P.price({ material: pla, tierNum: 2, grams: 50, hours: 4, qty: 1, colorKey: '1', abrasive: false, drying: false, supports: false, ...over });

test('two tiers only, and every material prices both', () => {
  assert.deepEqual(Object.keys(P.TIERS), ['1', '2']);
  assert.equal(P.TIERS[1].taxExempt, true);
  assert.equal(P.TIERS[2].taxExempt, false);
  for (const m of P.MATERIALS) assert.deepEqual(Object.keys(m.rates), ['1', '2']);
});

test('external tier, one copy: filament + time + labor, then tax and card fee', () => {
  const c = job();
  near(c.baseFilament, 50 * 0.0575);
  near(c.timeFee, 12);
  assert.equal(c.laborFee, 10);
  near(c.costSubtotal, 2.875 + 12 + 10);
  near(c.salesTax, c.costSubtotal * P.TAX_RATE);
  near(c.processingFee, (c.costSubtotal + c.salesTax) * P.PROCESSING_FEE_RATE);
  near(c.grandTotal, c.costSubtotal + c.salesTax + c.processingFee);
  assert.equal(c.minApplied, false);
});

test('BRC tier: materials, print time and setup; no labor, no sales tax; card fee still applies', () => {
  const c = job({ tierNum: 1, qty: 10 });
  near(c.baseFilament, 10 * 50 * 0.0299);
  near(c.timeFee, 10 * 4 * 1);
  assert.equal(c.laborFee, 0);
  assert.equal(c.setupFee, 1);
  near(c.costSubtotal, 14.95 + 40 + 1);
  assert.equal(c.salesTax, 0);
  near(c.processingFee, c.costSubtotal * P.PROCESSING_FEE_RATE);
  near(c.grandTotal, c.costSubtotal * (1 + P.PROCESSING_FEE_RATE));
  assert.ok(P.buildLines(c).some(l => l.label.startsWith('Sales tax — exempt') && l.value === 0));
  assert.equal(job({ tierNum: 1, grams: 1, hours: 0.1 }).minApplied, false); // no BRC minimum
});

test('quantity multiplies filament, color surcharge and print time only', () => {
  const opts = { colorKey: '2', abrasive: true, drying: true, supports: true };
  const one = job(opts), four = job({ ...opts, qty: 4 });
  near(four.baseFilament, 4 * one.baseFilament);
  near(four.colorSurchargeAmt, 4 * one.colorSurchargeAmt);
  near(four.timeFee, 4 * one.timeFee);
  assert.equal(four.laborFee, one.laborFee);
  assert.equal(four.setupFee, one.setupFee);
  assert.equal(four.abrasiveFee, 5);
  assert.equal(four.dryingFee, 3);
  assert.equal(four.supportsFee, 10);
  near(four.costSubtotal - one.costSubtotal, 3 * (one.baseFilament * 1.1 + one.timeFee));
});

test('quantity is clamped to a whole number of at least 1', () => {
  for (const q of [0, -2, NaN, undefined, '']) assert.equal(job({ qty: q }).qty, 1);
  assert.equal(job({ qty: 2.9 }).qty, 2);
  near(job({ qty: 2.9 }).baseFilament, 2 * 50 * 0.0575);
});

test('minimum charge applies to the whole job; more copies can lift a job above it', () => {
  const small = job({ grams: 5, hours: 1 });        // 0.2875 + 3 + 10 = 13.2875
  assert.equal(small.minApplied, true);
  near(small.costSubtotal, 15);
  const two = job({ grams: 5, hours: 1, qty: 2 });   // 0.575 + 6 + 10 = 16.575
  assert.equal(two.minApplied, false);
  near(two.costSubtotal, 16.575);
});

test('line labels show the copy count only above 1, and never on flat fees', () => {
  const single = P.buildLines(job({ supports: true })).map(l => l.label);
  assert.ok(single[0].startsWith('Filament — 50g ×'), single[0]);
  const multi = P.buildLines(job({ qty: 4, supports: true })).map(l => l.label);
  assert.ok(multi[0].startsWith('Filament — 4 × 50g ×'), multi[0]);
  assert.ok(multi.some(l => l.startsWith('Print time — 4 × 4h ×')));
  assert.ok(multi.includes('Labor (review, load, monitor, cleanup)'));
  assert.ok(multi.includes('Supports / complex geometry surcharge'));
  assert.ok(multi.some(l => l.startsWith('Sales tax — Vernal')));
});

test('print quality: standard matches the estimate profile, fine detail slows the flow', () => {
  assert.equal(P.QUALITY.standard.layerHeight, P.EST.layerHeight);
  assert.equal(P.QUALITY.standard.flowScale, 1);
  assert.ok(P.QUALITY.fine.layerHeight < P.EST.layerHeight);
  assert.equal(P.QUALITY.fine.flowScale, 0.4);
});

test('price range: ±25% on weight and time, flat fees unmoved', () => {
  const c = job({ qty: 2, supports: true }), r = P.priceRange({ material: pla, tierNum: 2, grams: 50, hours: 4, qty: 2, colorKey: '1', abrasive: false, drying: false, supports: true }, 0.25);
  near(r.low, job({ qty: 2, supports: true, grams: 37.5, hours: 3 }).grandTotal);
  near(r.high, job({ qty: 2, supports: true, grams: 62.5, hours: 5 }).grandTotal);
  assert.ok(r.low < c.grandTotal && c.grandTotal < r.high);
  assert.equal(r.flat, false);
  const tiny = P.priceRange({ material: pla, tierNum: 2, grams: 3, hours: 0.2, qty: 1, colorKey: '1', abrasive: false, drying: false, supports: false }, 0.25);
  assert.equal(tiny.flat, true); // both ends sit on the $15 minimum
  near(tiny.low, tiny.high);
});

test('multi-colour estimate multipliers grow with the colour count', () => {
  assert.equal(P.COLOR_OPTIONS['1'].estTime, 1);
  assert.equal(P.COLOR_OPTIONS['1'].estGrams, 1);
  assert.ok(P.COLOR_OPTIONS['2'].estTime > 1 && P.COLOR_OPTIONS['3'].estTime >= P.COLOR_OPTIONS['2'].estTime);
  assert.ok(P.COLOR_OPTIONS['2'].estGrams > 1 && P.COLOR_OPTIONS['3'].estGrams >= P.COLOR_OPTIONS['2'].estGrams);
  assert.ok(P.EST.bedX > 300 && P.EST.bedY > 300 && P.EST.spread > 0);
});
