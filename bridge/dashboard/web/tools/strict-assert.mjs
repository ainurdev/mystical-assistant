// console.assert prints a failure and the check still exits 0. Loaded by
// `npm run check` (both apps), so a failed assert fails its file under node --test.
const print = console.assert.bind(console);
console.assert = (ok, ...why) => {
  if (!ok) process.exitCode = 1;
  print(ok, ...why);
};
