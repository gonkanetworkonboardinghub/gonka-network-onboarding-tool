/**
 * background.js — whether closing GNOT's window closes GNOT, or leaves it
 * watching your nodes from an icon near the clock (renderer/watch.js does the
 * watching). Pure, so scripts/check-watch.js can pin it down.
 *
 *   "close"  closing closes GNOT, as it always has
 *   "hide"   the window goes, GNOT stays near the clock
 *   "ask"    ask once (the answer is kept in ui.json)
 *
 * Closing really closes GNOT when an update is waiting (it installs at the
 * next opening, as every update must), and when there is no node of your own
 * to watch. Asked only once someone has a node of their own.
 */
function onClose({ watchOn, own, updatePending }) {
  if (updatePending) return "close";
  if (!(own > 0)) return "close";
  if (watchOn === true) return "hide";
  if (watchOn === false) return "close";
  return "ask";
}

/** Started by the computer at login, to watch quietly: no window until asked for. */
function startsHidden(argv, loginSettings) {
  return (argv || []).includes("--hidden") || !!(loginSettings && loginSettings.wasOpenedAsHidden);
}

module.exports = { onClose, startsHidden };
