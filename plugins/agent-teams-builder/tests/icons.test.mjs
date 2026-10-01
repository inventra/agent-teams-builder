import assert from "node:assert/strict";
import test from "node:test";
import { icon } from "../web/icons.js";
import { CARD_LIBRARY } from "../web/workbench-model.js";

test("all card icons are registered local, decorative vectors without font or remote dependencies", () => {
  for (const { icon: name } of Object.values(CARD_LIBRARY)) {
    const vector = icon(name);
    assert.ok(vector.includes('data-icon="' + name + '"'), name);
    assert.ok(vector.includes('aria-hidden="true"'));
    assert.ok(vector.includes('focusable="false"'));
    assert.ok(vector.includes('stroke="currentColor"'));
    assert.doesNotMatch(vector, /<(?:use|image|text)\b|href=|url\(/);
  }
});

test("unknown, inherited or injected icon identifiers cannot become markup", () => {
  for (const name of ['<img src=x onerror=alert(1)>', '" onload="alert(1)', "__proto__", "toString", null]) {
    assert.equal(icon(name), icon("docs"));
  }
});
