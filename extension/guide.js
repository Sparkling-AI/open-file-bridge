// Open File Bridge — recovery guide page (fills the version stamp).
"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("ver");
  if (el) el.textContent = FS_VERSION;
});
