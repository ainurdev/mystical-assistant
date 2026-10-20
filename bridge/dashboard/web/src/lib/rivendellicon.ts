import { createLucideIcon } from "lucide-react";

/* Rivendell's own mark wherever the HUD means Rivendell (the rail tab, its
   panel's empty state, the notification icons): the logo's crystal between two
   leafy boughs whose stems cross at the foot. Redrawn as a lucide icon, on the
   24 grid in stroke only, so it takes size and strokeWidth like its neighbours. */
export const RivendellIcon = createLucideIcon("rivendell", [
  ["path", { d: "M12 2 14.2 8 12 13.5 9.8 8Z", key: "crystal" }],
  ["path", { d: "M14.5 22C10 19.5 7 16.4 6.4 11", key: "bough-l" }],
  ["path", { d: "M9.5 22C14 19.5 17 16.4 17.6 11", key: "bough-r" }],
  ["path", { d: "M6.4 11C7.8 8.2 7 5.5 4 3.8C2.9 6.8 3.6 9.3 6.4 11Z", key: "leaf-lt" }],
  ["path", { d: "M17.6 11C16.2 8.2 17 5.5 20 3.8C21.1 6.8 20.4 9.3 17.6 11Z", key: "leaf-rt" }],
  ["path", { d: "M7.8 15.8C6.6 13.2 4.4 12.4 1.6 13.1C2.9 15.8 5 16.6 7.8 15.8Z", key: "leaf-ls" }],
  ["path", { d: "M16.2 15.8C17.4 13.2 19.6 12.4 22.4 13.1C21.1 15.8 19 16.6 16.2 15.8Z", key: "leaf-rs" }],
]);
