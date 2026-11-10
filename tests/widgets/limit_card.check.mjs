// The limit card: its countdown to the resume time, and each state (ticket telegram-widgets 08).
import assert from "node:assert/strict";
import { check, load } from "./harness.mjs";

process.env.TZ = "UTC";
const NOW = 1794300000;                        // 08:40:00 UTC
const card = (s, extra = {}) => ({ v: 1, t: "Fix login", s, ...extra });

check("waiting counts down to the resume time, shown as a clock", () => {
  const p = load("limit.html", card("w", { a: NOW + 5025 }));
  assert.match(p.text(), /Fix login Waiting for the reset 1:23:45 resumes at 10:03/);
  p.tick(5);
  assert.match(p.text(), /1:23:40/);
});

check("under an hour drops the hours", () => {
  assert.match(load("limit.html", card("w", { a: NOW + 65 })).text(), / 1:05 resumes/);
});

check("a choice counts down and points at the buttons below", () => {
  assert.match(load("limit.html", card("c", { a: NOW + 60 })).text(), /Fix login Usage limit · switch or wait below 1:00 resumes at 08:41/);
});

check("a passed resume time says any moment, never a negative time", () => {
  assert.match(load("limit.html", card("w", { a: NOW - 30 })).text(), /any moment/);
});

check("resumed says so and when, with no countdown", () => {
  const t = load("limit.html", card("r", { e: NOW })).text();
  assert.equal(t, "▶ Fix login Resumed 08:40");
});

check("no longer parked says so and when", () => {
  assert.equal(load("limit.html", card("g", { e: NOW + 60 })).text(), "– Fix login No longer parked 08:41");
});

check("new data redraws the card", () => {
  const p = load("limit.html", card("c", { a: NOW + 60 }));
  p.data(card("r", { e: NOW }));
  assert.match(p.text(), /Resumed/);
});

check("an unknown version or state, or broken data, says the card is out of date", () => {
  assert.match(load("limit.html", { v: 2, s: "w" }).text(), /out of date/);
  assert.match(load("limit.html", card("x")).text(), /out of date/);
  assert.match(load("limit.html", "{nope").text(), /out of date/);
});

check("a title draws as text, in its own direction", () => {
  const h = load("limit.html", card("w", { a: NOW, t: "<b>x</b>" })).html();
  assert.match(h, /dir="auto">&#60;b&#62;x&#60;\/b&#62;</);
});
