// The native-app tells: the Mac app and the Windows app tag their web views'
// user agents, and the page gates its native-only behaviour on them.
//   node --experimental-strip-types src/lib/mac.check.ts
// Node's own global navigator is a getter; replace the property outright.
const ua = (s: string) => {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: s }, configurable: true, writable: true });
};
ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0 Safari/537.36 Edg/155.0 MysticalWin/v1");
const { isMacApp, isWinApp, isNativeApp } = await import("./mac.ts");
console.assert(isWinApp() && !isMacApp() && isNativeApp(), "a MysticalWin user agent is the Windows app, and native");
ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15 MysticalMac/1.0");
console.assert(isMacApp() && !isWinApp() && isNativeApp(), "a MysticalMac user agent is the Mac app, and native");
ua("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/155.0 Safari/537.36");
console.assert(!isMacApp() && !isWinApp() && !isNativeApp(), "a plain browser is neither");
console.log("mac.check: done");
